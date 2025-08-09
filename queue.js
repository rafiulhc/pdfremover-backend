// queue.js
const { Queue } = require('bullmq');
const IORedis = require('ioredis');

// Heroku Redis Cloud usually gives a rediss:// URL with TLS.
// BullMQ v5 takes an ioredis instance or connection opts.
// We'll pass a single ioredis client with TLS enabled automatically via the URL.
const REDIS_URL = process.env.REDIS_URL || process.env.REDISCLOUD_URL;

if (!REDIS_URL) {
  console.warn("⚠️ No REDIS_URL/REDISCLOUD_URL set. Queue will fail to connect.");
}

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true
});

const pdfQueue = new Queue('pdf-jobs', { connection });

module.exports = { pdfQueue, connection };
