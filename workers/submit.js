'use strict';

const { parentPort } = require('worker_threads');

const packageData = require('../package.json');
const config = require('wild-config');
const logger = require('../lib/logger');

const { REDIS_PREFIX } = require('../lib/consts');
const { getDuration, readEnvValue } = require('../lib/tools');

const Bugsnag = require('@bugsnag/js');
if (readEnvValue('BUGSNAG_API_KEY')) {
    Bugsnag.start({
        apiKey: readEnvValue('BUGSNAG_API_KEY'),
        appVersion: packageData.version,
        logger: {
            debug(...args) {
                logger.debug({ msg: args.shift(), worker: 'submit', source: 'bugsnag', args: args.length ? args : undefined });
            },
            info(...args) {
                logger.debug({ msg: args.shift(), worker: 'submit', source: 'bugsnag', args: args.length ? args : undefined });
            },
            warn(...args) {
                logger.warn({ msg: args.shift(), worker: 'submit', source: 'bugsnag', args: args.length ? args : undefined });
            },
            error(...args) {
                logger.error({ msg: args.shift(), worker: 'submit', source: 'bugsnag', args: args.length ? args : undefined });
            }
        }
    });
}

const util = require('util');
const { redis, notifyQueue, queueConf } = require('../lib/db');
const { Worker } = require('bullmq');
const { Account } = require('../lib/account');
const getSecret = require('../lib/get-secret');
const settings = require('../lib/settings');
const msgpack = require('msgpack5')();

const { EMAIL_FAILED_NOTIFY } = require('../lib/consts');

config.smtp = config.smtp || {
    port: 2525,
    host: '127.0.0.1'
};

config.queues = config.queues || {
    submit: 1
};

config.service = config.service || {};

const DEFAULT_EENGINE_TIMEOUT = 10 * 1000;

const EENGINE_TIMEOUT = getDuration(readEnvValue('EENGINE_TIMEOUT') || config.service.commandTimeout) || DEFAULT_EENGINE_TIMEOUT;

const SUBMIT_QC = (readEnvValue('EENGINE_SUBMIT_QC') && Number(readEnvValue('EENGINE_SUBMIT_QC'))) || config.queues.submit || 1;

let callQueue = new Map();
let mids = 0;

async function call(message, transferList) {
    return new Promise((resolve, reject) => {
        let mid = `${Date.now()}:${++mids}`;

        let timer = setTimeout(() => {
            let err = new Error('Timeout waiting for command response [T5]');
            err.statusCode = 504;
            err.code = 'Timeout';
            reject(err);
        }, message.timeout || EENGINE_TIMEOUT);

        callQueue.set(mid, { resolve, reject, timer });

        parentPort.postMessage(
            {
                cmd: 'call',
                mid,
                message
            },
            transferList
        );
    });
}

async function metrics(logger, key, method, ...args) {
    try {
        parentPort.postMessage({
            cmd: 'metrics',
            key,
            method,
            args
        });
    } catch (err) {
        logger.error({ msg: 'Failed to post metrics to parent', err });
    }
}

async function notify(account, event, data) {
    metrics(logger, 'events', 'inc', {
        event
    });

    let payload = {
        account,
        date: new Date().toISOString()
    };

    if (event) {
        payload.event = event;
    }

    if (data) {
        payload.data = data;
    }

    let queueKeep = (await settings.get('queueKeep')) || true;
    await notifyQueue.add(event, payload, {
        removeOnComplete: queueKeep,
        removeOnFail: queueKeep,
        attempts: 10,
        backoff: {
            type: 'exponential',
            delay: 5000
        }
    });
}

const smtpLogger = {};
for (let level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
    smtpLogger[level] = (data, message, ...args) => {
        if (args && args.length) {
            message = util.format(message, ...args);
        }
        data.msg = message;
        data.sub = 'smtp-server';
        if (typeof logger[level] === 'function') {
            logger[level](data);
        } else {
            logger.debug(data);
        }
    };
}

const submitWorker = new Worker(
    'submit',
    async job => {
        if (!job.data.queueId && job.data.qId) {
            // this value was used to be called qId
            job.data.queueId = job.data.qId;
        }

        let queueEntryBuf = await redis.hgetBuffer(`${REDIS_PREFIX}iaq:${job.data.account}`, job.data.queueId);
        if (!queueEntryBuf) {
            // nothing to do here
            try {
                await redis.hdel(`${REDIS_PREFIX}iaq:${job.data.account}`, job.data.queueId);
            } catch (err) {
                // ignore
            }
            return;
        }

        let queueEntry;
        try {
            queueEntry = msgpack.decode(queueEntryBuf);
        } catch (err) {
            logger.error({ msg: 'Failed to parse queued email entry', job: job.data, err });
            try {
                await redis.hdel(`${REDIS_PREFIX}iaq:${job.data.account}`, job.data.queueId);
            } catch (err) {
                // ignore
            }
            return;
        }

        if (!queueEntry) {
            //could be expired?
            return false;
        }

        let accountObject = new Account({ account: job.data.account, redis, call, secret: await getSecret() });

        logger.trace({
            msg: 'Processing message',
            action: 'submit',
            queue: job.queue.name,
            code: 'processing',
            job: job.id,
            event: job.name,
            data: job.data,
            account: job.data.account
        });

        try {
            try {
                // try to update
                await job.updateProgress({
                    status: 'processing'
                });
            } catch (err) {
                // ignore
            }

            let backoffDelay = Number(job.opts.backoff && job.opts.backoff.delay) || 0;
            let nextAttempt = job.attemptsMade < job.opts.attempts ? Math.round(job.processedOn + Math.pow(2, job.attemptsMade) * backoffDelay) : false;

            queueEntry.job = {
                attemptsMade: job.attemptsMade,
                attempts: job.opts.attempts,
                nextAttempt: new Date(nextAttempt).toISOString()
            };

            let res = await accountObject.submitMessage(queueEntry);

            logger.trace({
                msg: 'Submitted queued message for delivery',
                action: 'submit',
                queue: job.queue.name,
                code: 'result_success',
                job: job.id,
                event: job.name,
                data: job.data,
                account: job.data.account
            });

            try {
                // try to update
                await job.updateProgress({
                    status: 'submitted',
                    response: res.response
                });
            } catch (err) {
                // ignore
            }
        } catch (err) {
            logger.error({
                msg: 'Message submission failed',
                action: 'submit',
                queue: job.queue.name,
                code: 'result_fail',
                job: job.id,
                event: job.name,
                data: job.data,
                account: job.data.account,
                err
            });

            try {
                // try to update
                await job.updateProgress({
                    status: 'error',
                    error: {
                        message: err.message,
                        code: err.code,
                        statusCode: err.statusCode
                    }
                });
            } catch (err) {
                // ignore
            }

            if (err.statusCode >= 500 && job.attemptsMade < job.opts.attempts) {
                try {
                    // do not retry after 5xx error
                    await job.discard();
                    logger.info({
                        msg: 'Job discarded',
                        account: queueEntry.account,
                        queueId: job.data.queueId
                    });
                } catch (E) {
                    // ignore
                    logger.error({ msg: 'Failed to discard job', account: queueEntry.account, queueId: job.data.queueId, err: E });

                    logger.error({
                        msg: 'Failed to discard job',
                        action: 'submit',
                        queue: job.queue.name,
                        code: 'discard_fail',
                        job: job.id,
                        event: job.name,
                        data: job.data,
                        account: job.data.account,
                        err: E
                    });
                }
            }

            throw err;
        }
    },
    Object.assign(
        {
            concurrency: SUBMIT_QC
        },
        queueConf
    )
);

submitWorker.on('completed', async job => {
    metrics(logger, 'queuesProcessed', 'inc', {
        queue: 'submit',
        status: 'completed'
    });

    if (!job.data.queueId && job.data.qId) {
        // this value was used to be called qId
        job.data.queueId = job.data.qId;
    }

    if (job.data && job.data.account && job.data.queueId) {
        try {
            await redis.hdel(`${REDIS_PREFIX}iaq:${job.data.account}`, job.data.queueId);
        } catch (err) {
            logger.error({ msg: 'Failed to remove queue entry', account: job.data.account, queueId: job.data.queueId, messageId: job.data.messageId, err });
        }
    }

    logger.info({
        msg: 'Submission queue entry completed',
        action: 'submit',
        queue: job.queue.name,
        code: 'completed',
        job: job.id,
        account: job.data.account
    });
});

submitWorker.on('failed', async job => {
    metrics(logger, 'queuesProcessed', 'inc', {
        queue: 'submit',
        status: 'failed'
    });

    if (job.finishedOn || job.discarded) {
        // this was final attempt, remove it
        if (!job.data.queueId && job.data.qId) {
            // this value was used to be called qId
            job.data.queueId = job.data.qId;
        }
        if (job.data && job.data.account && job.data.queueId) {
            try {
                await redis.hdel(`${REDIS_PREFIX}iaq:${job.data.account}`, job.data.queueId);
            } catch (err) {
                logger.error({ msg: 'Failed to remove queue entry', account: job.data.account, queueId: job.data.queueId, messageId: job.data.messageId, err });
            }
            // report as failed
            await notify(job.data.account, EMAIL_FAILED_NOTIFY, {
                messageId: job.data.messageId,
                queueId: job.data.queueId,
                error: job.stacktrace && job.stacktrace[0] && job.stacktrace[0].split('\n').shift()
            });
        }
    }

    logger.info({
        msg: 'Submission queue entry failed',
        action: 'submit',
        queue: job.queue.name,
        code: 'failed',
        job: job.id,
        account: job.data.account,

        failedReason: job.failedReason,
        stacktrace: job.stacktrace,
        attemptsMade: job.attemptsMade
    });
});

async function onCommand(command) {
    logger.debug({ msg: 'Unhandled command', command });
}

parentPort.on('message', message => {
    if (message && message.cmd === 'resp' && message.mid && callQueue.has(message.mid)) {
        let { resolve, reject, timer } = callQueue.get(message.mid);
        clearTimeout(timer);
        callQueue.delete(message.mid);
        if (message.error) {
            let err = new Error(message.error);
            if (message.code) {
                err.code = message.code;
            }
            if (message.statusCode) {
                err.statusCode = message.statusCode;
            }
            return reject(err);
        } else {
            return resolve(message.response);
        }
    }

    if (message && message.cmd === 'call' && message.mid) {
        return onCommand(message.message)
            .then(response => {
                parentPort.postMessage({
                    cmd: 'resp',
                    mid: message.mid,
                    response
                });
            })
            .catch(err => {
                parentPort.postMessage({
                    cmd: 'resp',
                    mid: message.mid,
                    error: err.message,
                    code: err.code,
                    statusCode: err.statusCode
                });
            });
    }
});

logger.info({ msg: 'Started SMTP submission worker thread', version: packageData.version });
