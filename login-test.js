import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import https from 'https';
import http from 'http';
import { Buffer } from 'buffer';

// =============================================
// LOGIN API AUTOMATION TEST CONFIGURATION
// =============================================
const TARGET_URL = process.env.TARGET_URL || 'https://52gs.co/chklogin.asp';
const LOGIN_CREDENTIALS = {
  id: process.env.LOGIN_USER || 'asd123123',          // Login username
  password: process.env.LOGIN_PASS || 'asd123123',  // Login password
};

// Stress test parameters
const TOTAL_REQUESTS = parseInt(process.env.TOTAL_REQUESTS) || 5000000000000000;
const TARGET_RPS = parseInt(process.env.TARGET_RPS) || 66667; // Target: ~1,000,000 requests per minute
const CONCURRENCY_LIMIT = parseInt(process.env.CONCURRENCY_LIMIT) || 1000; // Allow up to 2000 concurrent sockets
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS) || 5000; // 5 seconds timeout per call

// =============================================
// Build POST body (application/x-www-form-urlencoded)
// =============================================
function buildFormBody(params) {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

const postBody = buildFormBody(LOGIN_CREDENTIALS);
const postBodyBuffer = Buffer.from(postBody, 'utf-8');

async function runLoginAutomation() {
  console.log(`\n========================================`);
  console.log(`  LOGIN API AUTOMATION STRESS TEST`);
  console.log(`========================================`);
  console.log(`Target URL:        ${TARGET_URL}`);
  console.log(`Login ID:          ${LOGIN_CREDENTIALS.id}`);
  console.log(`Total Requests:    ${TOTAL_REQUESTS}`);
  console.log(`Target RPS:        ${TARGET_RPS > 0 ? TARGET_RPS : 'Unlimited'}`);
  console.log(`Concurrency Limit: ${CONCURRENCY_LIMIT}`);
  console.log(`Request Timeout:   ${REQUEST_TIMEOUT_MS}ms`);
  console.log(`POST Body:         ${postBody}`);
  console.log(`----------------------------------------------\n`);

  const startTime = Date.now();
  let completedCount = 0;
  let successCount = 0;
  let failureCount = 0;

  const responseTimes = [];
  const errors = new Map();
  const statusCodes = new Map();
  const responseBodySamples = []; // Collect first few response bodies for analysis

  let nextRequestIndex = 0;
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
    method: 'POST',
    agent: agent,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': postBodyBuffer.length,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Origin': 'https://52gs.co',
      'Referer': 'https://52gs.co/login.html',
    },
  };

  const isTTY = process.stdout.isTTY;

  // Render a visual progress bar
  function drawProgressBar() {
    const width = 30;
    const progress = completedCount / TOTAL_REQUESTS;
    const filledLength = Math.round(width * progress);
    const emptyLength = width - filledLength;
    const bar = '='.repeat(filledLength) + ' '.repeat(emptyLength);
    const percent = (progress * 100).toFixed(1);

    const statsText = `[${bar}] ${percent}% | ${completedCount}/${TOTAL_REQUESTS} | Success: ${successCount} | Failed: ${failureCount} | Active: ${activeRequestsCount}`;

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
  const updateIntervalMs = isTTY ? 100 : 5000;

  function maybeDrawProgressBar() {
    const now = Date.now();
    if (now - lastProgressUpdate >= updateIntervalMs || completedCount === TOTAL_REQUESTS) {
      lastProgressUpdate = now;
      drawProgressBar();
    }
  }

  // Dispatch a single POST login request
  function dispatchRequest(currentIndex) {
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
            requestIndex: currentIndex,
            statusCode: status,
            body: body,
          });
        }

        const locationHeader = res.headers.location || '';
        const isBlock = (status === 403) || (status === 429) || (status === 302 && locationHeader.includes('error.asp'));

        if (isBlock) {
          failureCount++;
          const blockType = status === 403 ? 'Cloudflare WAF Block (403)' : (status === 429 ? 'Rate Limit (429)' : 'Login Limit Redirect (302)');
          errors.set(blockType, (errors.get(blockType) || 0) + 1);
        } else if (status >= 200 && status < 400) {
          successCount++;
        } else {
          failureCount++;
          const statusText = `HTTP ${status} ${res.statusMessage || ''}`;
          errors.set(statusText, (errors.get(statusText) || 0) + 1);
        }

        activeRequestsCount--;
        completedCount++;
        maybeDrawProgressBar();
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
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      timedOut = true;
      req.destroy();

      failureCount++;
      errors.set('Timeout', (errors.get('Timeout') || 0) + 1);

      activeRequestsCount--;
      completedCount++;
      maybeDrawProgressBar();
    });

    // Write the POST body and send the request
    req.write(postBodyBuffer);
    req.end();
  }

  // Rate-limiting scheduler
  async function startScheduler() {
    while (nextRequestIndex < TOTAL_REQUESTS) {
      if (activeRequestsCount >= CONCURRENCY_LIMIT) {
        await new Promise((resolve) => setImmediate(resolve));
        continue;
      }



      if (TARGET_RPS > 0) {
        const elapsedMs = Date.now() - startTime;
        const expectedDispatched = (elapsedMs / 1000) * TARGET_RPS;
        if (nextRequestIndex >= expectedDispatched) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          continue;
        }
      }

      const currentIndex = nextRequestIndex++;
      if (currentIndex >= TOTAL_REQUESTS) {
        break;
      }

      activeRequestsCount++;
      dispatchRequest(currentIndex);
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
      testType: 'LOGIN_POST_STRESS_TEST',
      targetUrl: TARGET_URL,
      loginId: LOGIN_CREDENTIALS.id,
      totalRequests: completedCount,
      concurrencyLimit: CONCURRENCY_LIMIT,
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
        p99: p99Latency,
      },
      statusCodes: Object.fromEntries(statusCodes.entries()),
      errors: Object.fromEntries(errors.entries()),
      responseBodySamples: responseBodySamples,
    };

    console.log(`\n\n=== LOGIN STRESS TEST PERFORMANCE REPORT ===`);
    console.log(`Test Type:         LOGIN POST`);
    console.log(`Target URL:        ${TARGET_URL}`);
    console.log(`Login ID:          ${LOGIN_CREDENTIALS.id}`);
    console.log(`Duration:          ${durationTotalSeconds}s`);
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

    if (responseBodySamples.length > 0) {
      console.log(`\nSample Response Bodies (first ${responseBodySamples.length}):`);
      for (const sample of responseBodySamples) {
        console.log(`  [Request #${sample.requestIndex}] Status ${sample.statusCode}:`);
        console.log(`    ${sample.body.substring(0, 200)}...`);
      }
    }

    const reportPath = path.join(process.cwd(), `summary-report-login-${process.pid}.json`);
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
}

runLoginAutomation().catch((err) => {
  console.error('Fatal error running login automation:', err);
});
