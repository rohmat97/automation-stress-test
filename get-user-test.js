import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import https from 'https';
import http from 'http';

// =============================================
// GET USER API AUTOMATION TEST CONFIGURATION
// =============================================
const TARGET_URL = process.env.TARGET_URL || 'https://52gs.co/user.asp';

// Duration-based test parameters
const TEST_DURATION_MINUTES = parseInt(process.env.TEST_DURATION_MINUTES) || 330; // 5.5 hours
const TARGET_RPS = parseInt(process.env.TARGET_RPS) || 50; // Sustainable rate to avoid WAF blocks
const CONCURRENCY_LIMIT = parseInt(process.env.CONCURRENCY_LIMIT) || 10; // Conservative to avoid IP bans
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS) || 10000; // 10 seconds timeout per call

// Adaptive backoff settings
const CONSECUTIVE_FAIL_THRESHOLD = 20;
const BACKOFF_MIN_MS = 15000;
const BACKOFF_MAX_MS = 60000;
const JITTER_MAX_MS = 200;

async function runGetUserAutomation() {
  const testDurationMs = TEST_DURATION_MINUTES * 60 * 1000;
  const endTime = Date.now() + testDurationMs;

  console.log(`\n========================================`);
  console.log(`  GET USER API AUTOMATION STRESS TEST`);
  console.log(`========================================`);
  console.log(`Target URL:        ${TARGET_URL}`);
  console.log(`Test Duration:     ${TEST_DURATION_MINUTES} minutes (${(TEST_DURATION_MINUTES / 60).toFixed(1)} hours)`);
  console.log(`Target RPS:        ${TARGET_RPS > 0 ? TARGET_RPS : 'Unlimited'}`);
  console.log(`Concurrency Limit: ${CONCURRENCY_LIMIT}`);
  console.log(`Request Timeout:   ${REQUEST_TIMEOUT_MS}ms`);
  console.log(`Backoff Threshold: ${CONSECUTIVE_FAIL_THRESHOLD} consecutive failures`);
  console.log(`----------------------------------------------\n`);

  const startTime = Date.now();
  let completedCount = 0;
  let successCount = 0;
  let failureCount = 0;
  let consecutiveFailures = 0;
  let totalBackoffTimeMs = 0;
  let backoffCount = 0;

  const responseTimes = [];
  const errors = new Map();
  const statusCodes = new Map();
  const responseBodySamples = []; // Collect first few response bodies for analysis

  let dispatched = 0;
  let activeRequestsCount = 0;

  // Set up high-performance client Agent
  const parsedUrl = new URL(TARGET_URL);
  const isHttps = parsedUrl.protocol === 'https:';
  const client = isHttps ? https : http;
  const agent = new client.Agent({
    keepAlive: true,
    maxSockets: CONCURRENCY_LIMIT,
    keepAliveMsecs: 60000,
  });

  const requestOptions = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (isHttps ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'GET',
    agent: agent,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': 'https://52gs.co/',
    },
  };

  const isTTY = process.stdout.isTTY;

  // Render a visual progress bar (time-based)
  function drawProgressBar() {
    const width = 30;
    const elapsed = Date.now() - startTime;
    const progress = Math.min(elapsed / testDurationMs, 1);
    const filledLength = Math.round(width * progress);
    const emptyLength = width - filledLength;
    const bar = '='.repeat(filledLength) + ' '.repeat(emptyLength);
    const percent = (progress * 100).toFixed(1);

    const elapsedMin = (elapsed / 60000).toFixed(1);
    const totalMin = TEST_DURATION_MINUTES;

    const statsText = `[${bar}] ${percent}% | ${elapsedMin}/${totalMin}min | Reqs: ${completedCount} | OK: ${successCount} | Fail: ${failureCount} | Active: ${activeRequestsCount}`;

    if (isTTY) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(statsText);
    } else {
      console.log(statsText);
    }
  }

  // Throttle CLI updates
  let lastProgressUpdate = 0;
  const updateIntervalMs = isTTY ? 100 : 15000;

  function maybeDrawProgressBar() {
    const now = Date.now();
    if (now - lastProgressUpdate >= updateIntervalMs || now >= endTime) {
      lastProgressUpdate = now;
      drawProgressBar();
    }
  }

  // Dispatch a single GET user request
  function dispatchRequest() {
    return new Promise((resolve) => {
      const requestStartTime = Date.now();
      let timedOut = false;

      const req = client.request(requestOptions, (res) => {
        const chunks = [];

        res.on('data', (chunk) => {
          // Collect response body for the first few requests for analysis
          if (responseBodySamples.length < 5) {
            chunks.push(chunk);
          }
        });

        res.on('end', () => {
          if (timedOut) return;

          const duration = Date.now() - requestStartTime;
          responseTimes.push(duration);

          const status = res.statusCode;
          statusCodes.set(status, (statusCodes.get(status) || 0) + 1);

          // Collect sample response bodies for debugging
          if (responseBodySamples.length < 5 && chunks.length > 0) {
            const body = Buffer.concat(chunks).toString('utf-8').substring(0, 500);
            responseBodySamples.push({
              requestIndex: dispatched,
              statusCode: status,
              body: body,
            });
          }

          const locationHeader = res.headers.location || '';
          const isBlock = (status === 403) || (status === 429) || (status === 302 && locationHeader.includes('error.asp'));

          if (isBlock) {
            failureCount++;
            consecutiveFailures++;
            const blockType = status === 403 ? 'Cloudflare WAF Block (403)' : (status === 429 ? 'Rate Limit (429)' : 'Redirect to Error (302)');
            errors.set(blockType, (errors.get(blockType) || 0) + 1);
          } else if (status >= 200 && status < 400) {
            successCount++;
            consecutiveFailures = 0;
          } else {
            failureCount++;
            consecutiveFailures++;
            const statusText = `HTTP ${status} ${res.statusMessage || ''}`;
            errors.set(statusText, (errors.get(statusText) || 0) + 1);
          }

          activeRequestsCount--;
          completedCount++;
          maybeDrawProgressBar();
          resolve();
        });
      });

      req.on('error', (err) => {
        if (timedOut) return;

        failureCount++;
        consecutiveFailures++;
        const errMsg = err.code || err.message || err.toString() || 'Unknown Error';
        errors.set(errMsg, (errors.get(errMsg) || 0) + 1);

        activeRequestsCount--;
        completedCount++;
        maybeDrawProgressBar();
        resolve();
      });

      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        timedOut = true;
        req.destroy();

        failureCount++;
        consecutiveFailures++;
        errors.set('Timeout', (errors.get('Timeout') || 0) + 1);

        activeRequestsCount--;
        completedCount++;
        maybeDrawProgressBar();
        resolve();
      });

      // Send the GET request
      req.end();
    });
  }

  // Random jitter
  function randomJitter() {
    return Math.floor(Math.random() * JITTER_MAX_MS);
  }

  // Adaptive backoff when too many consecutive failures
  async function maybeBackoff() {
    if (consecutiveFailures >= CONSECUTIVE_FAIL_THRESHOLD) {
      const backoffMs = BACKOFF_MIN_MS + Math.floor(Math.random() * (BACKOFF_MAX_MS - BACKOFF_MIN_MS));
      backoffCount++;
      totalBackoffTimeMs += backoffMs;
      console.log(`\n[Backoff #${backoffCount}] ${consecutiveFailures} consecutive failures detected. Pausing for ${(backoffMs / 1000).toFixed(0)}s...`);
      consecutiveFailures = 0;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  // Duration-based scheduler
  async function startScheduler() {
    while (Date.now() < endTime) {
      // Check for adaptive backoff
      await maybeBackoff();

      // If time is up after backoff, stop
      if (Date.now() >= endTime) break;

      if (activeRequestsCount >= CONCURRENCY_LIMIT) {
        await new Promise((resolve) => setImmediate(resolve));
        continue;
      }

      if (TARGET_RPS > 0) {
        const elapsedMs = Date.now() - startTime;
        const expectedDispatched = (elapsedMs / 1000) * TARGET_RPS;
        if (dispatched >= expectedDispatched) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          continue;
        }
      }

      dispatched++;
      activeRequestsCount++;
      dispatchRequest();

      // Add random jitter between dispatches
      if (JITTER_MAX_MS > 0 && Math.random() < 0.3) {
        await new Promise((resolve) => setTimeout(resolve, randomJitter()));
      }
    }
  }

  async function saveReport() {
    const durationTotalSeconds = ((Date.now() - startTime) / 1000).toFixed(2);

    responseTimes.sort((a, b) => a - b);
    const totalCalls = responseTimes.length;
    const minLatency = totalCalls > 0 ? responseTimes[0] : 0;
    const maxLatency = totalCalls > 0 ? responseTimes[totalCalls - 1] : 0;
    const avgLatency = totalCalls > 0 ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / totalCalls) : 0;
    const medianLatency = totalCalls > 0 ? responseTimes[Math.floor(totalCalls / 2)] : 0;
    const p95Latency = totalCalls > 0 ? responseTimes[Math.floor(totalCalls * 0.95)] : 0;
    const p99Latency = totalCalls > 0 ? responseTimes[Math.floor(totalCalls * 0.99)] : 0;

    const summary = {
      testType: 'GET_USER_STRESS_TEST',
      targetUrl: TARGET_URL,
      testDurationMinutes: TEST_DURATION_MINUTES,
      totalRequests: completedCount,
      concurrencyLimit: CONCURRENCY_LIMIT,
      targetRps: TARGET_RPS,
      durationSeconds: parseFloat(durationTotalSeconds),
      requestsPerSecond: parseFloat((completedCount / durationTotalSeconds).toFixed(2)) || 0,
      successCount,
      failureCount,
      successRate: completedCount > 0 ? `${((successCount / completedCount) * 100).toFixed(1)}%` : '0%',
      backoffCount,
      totalBackoffTimeSeconds: parseFloat((totalBackoffTimeMs / 1000).toFixed(1)),
      latencyStatsMs: {
        min: minLatency,
        max: maxLatency,
        avg: avgLatency,
        median: medianLatency,
        p95: p95Latency,
        p99: p99Latency,
      },
      statusCodes: Object.fromEntries(statusCodes.entries()),
      errors: Object.fromEntries(errors.entries()),
      responseBodySamples: responseBodySamples,
    };

    console.log(`\n\n=== GET USER STRESS TEST PERFORMANCE REPORT ===`);
    console.log(`Test Type:         GET USER`);
    console.log(`Target URL:        ${TARGET_URL}`);
    console.log(`Duration:          ${durationTotalSeconds}s`);
    console.log(`Total Requests:    ${completedCount}`);
    console.log(`Requests/Sec:      ${summary.requestsPerSecond}`);
    console.log(`Success Rate:      ${summary.successRate}`);
    console.log(`Backoffs:          ${backoffCount} (total ${(totalBackoffTimeMs / 1000).toFixed(0)}s paused)`);
    console.log(`Min Latency:       ${minLatency}ms`);
    console.log(`Max Latency:       ${maxLatency}ms`);
    console.log(`Avg Latency:       ${avgLatency}ms`);
    console.log(`Median Latency:    ${medianLatency}ms`);
    console.log(`p95 Latency:       ${p95Latency}ms`);
    console.log(`p99 Latency:       ${p99Latency}ms`);

    if (statusCodes.size > 0) {
      console.log(`\nHTTP Status Code Distribution:`);
      for (const [code, count] of statusCodes.entries()) {
        console.log(`  - Status ${code}: ${count}`);
      }
    }

    if (errors.size > 0) {
      console.log(`\nErrors Breakdown:`);
      for (const [errMsg, count] of errors.entries()) {
        console.log(`  - ${errMsg}: ${count}`);
      }
    }

    if (responseBodySamples.length > 0) {
      console.log(`\nSample Response Bodies (first ${responseBodySamples.length}):`);
      for (const sample of responseBodySamples) {
        console.log(`  [Request #${sample.requestIndex}] Status ${sample.statusCode}:`);
        console.log(`    ${sample.body.substring(0, 200)}...`);
      }
    }

    const reportPath = path.join(process.cwd(), `summary-report-getuser-${process.pid}.json`);
    await fs.writeFile(reportPath, JSON.stringify(summary, null, 2), 'utf-8');
    console.log(`\nDetailed report written to: ${reportPath}`);
  }

  // Graceful shutdown on Ctrl+C
  let shuttingDown = false;
  const handleShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n\n[Ctrl+C] Interrupted. Saving report...');
    await saveReport();
    process.exit(0);
  };
  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  // Run the scheduler
  await startScheduler();
  while (activeRequestsCount > 0) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  console.log('\n----------------------------------------------');
  const durationTotalSeconds = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`Execution Completed in ${durationTotalSeconds}s`);

  process.off('SIGINT', handleShutdown);
  process.off('SIGTERM', handleShutdown);

  await saveReport();

  // Always exit 0 — results are in the report artifact
  console.log(`\nTest finished. Check the report artifact for detailed results.`);
  process.exit(0);
}

runGetUserAutomation().catch((err) => {
  console.error('Fatal error running get user automation:', err);
  process.exit(1);
});
