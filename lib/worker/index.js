const Queue = require('bull')
const Sentry = require('@sentry/node')

const { discovery } = require('../sync/discovery')
const { processInstallation } = require('../sync/installation')
const { processPush } = require('../transforms/push')
const metricsJob = require('./metrics-job')
const statsd = require('../config/statsd')

const limiterPerInstallation = require('./limiter')

const app = require('./app')

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379'
const { CONCURRENT_WORKERS = 1 } = process.env
const AxiosErrorEventDecorator = require('../models/axios-error-event-decorator')
const SentryScopeProxy = require('../models/sentry-scope-proxy')

function measureElapsedTime (startTime, tags) {
  const endTime = new Date()
  var timeDiff = endTime - startTime
  statsd.histogram('job_duration', timeDiff, tags)
}

// Setup queues
const queues = {
  discovery: new Queue('Content discovery', REDIS_URL),
  installation: new Queue('Initial sync', REDIS_URL),
  push: new Queue('Push transformation', REDIS_URL),
  metrics: new Queue('Metrics', REDIS_URL)
}

// Setup error handling for queues
Object.keys(queues).forEach(name => {
  const queue = queues[name]

  queue.on('active', function (job, jobPromise) {
    app.log.info(`Job started name=${name} id=${job.id}`)
    job.meta_time_start = new Date()
  })

  queue.on('completed', function (job, jobPromise) {
    app.log.info(`Job completed name=${name} id=${job.id}`)
    measureElapsedTime(job.meta_time_start, { queue: name, status: 'completed' })
  })

  queue.on('failed', async (job, err) => {
    app.log.error(`Error occurred while processing job id=${job.id} on queue name=${name}`)
    measureElapsedTime(job.meta_time_start, { queue: name, status: 'failed' })
  })

  queue.on('error', (err) => {
    app.log.error(`Error occurred while processing queue ${name}: ${err}`)

    Sentry.setTag('queue', name)
    Sentry.captureException(err)
  })
})

// Return an async function that assigns a Sentry hub to `job.sentry` and sends exceptions.
const sentryMiddleware = function (jobHandler) {
  return async (job) => {
    job.sentry = new Sentry.Hub(Sentry.getCurrentHub().getClient())
    job.sentry.configureScope(scope => scope.addEventProcessor(AxiosErrorEventDecorator.decorate))
    job.sentry.configureScope(scope => scope.addEventProcessor(SentryScopeProxy.processEvent))

    try {
      await jobHandler(job)
    } catch (err) {
      job.sentry.setExtra('job', {
        id: job.id,
        attemptsMade: job.attemptsMade,
        timestamp: new Date(job.timestamp),
        data: job.data
      })

      job.sentry.setTag('jiraHost', job.data.jiraHost)
      job.sentry.setTag('queue', job.queue.name)
      job.sentry.captureException(err)

      throw err
    }
  }
}

module.exports = {
  queues,

  start () {
    queues.discovery.process(5, sentryMiddleware(discovery(app, queues)))
    queues.installation.process(Number(CONCURRENT_WORKERS), sentryMiddleware(processInstallation(app, queues)))
    queues.push.process(Number(CONCURRENT_WORKERS), sentryMiddleware(limiterPerInstallation(processPush(app))))
    queues.metrics.process(1, sentryMiddleware(metricsJob))

    app.log(`Worker process started with ${CONCURRENT_WORKERS} CONCURRENT WORKERS`)
  },

  async clean () {
    const gracePeriod = 10000
    const limit = 50000

    return Promise.all([
      queues.discovery.clean(gracePeriod, 'completed', limit),
      queues.discovery.clean(gracePeriod, 'failed', limit),
      queues.installation.clean(gracePeriod, 'completed', limit),
      queues.installation.clean(gracePeriod, 'failed', limit),
      queues.push.clean(gracePeriod, 'completed', limit),
      queues.push.clean(gracePeriod, 'failed', limit),
      queues.metrics.clean(gracePeriod, 'completed', limit),
      queues.metrics.clean(gracePeriod, 'failed', limit)
    ])
  },

  async stop () {
    return Promise.all([
      queues.discovery.close(),
      queues.installation.close(),
      queues.push.close(),
      queues.metrics.close()
    ])
  }
}
