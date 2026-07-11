import fs from 'fs/promises';
import path from 'path';

async function aggregate() {
  const dir = process.cwd();
  const files = await fs.readdir(dir);
  const reportFiles = files.filter(f => /^summary-report-\d+\.json$/.test(f));

  if (reportFiles.length === 0) {
    console.log('No individual summary-report-*.json files found to aggregate.');
    return;
  }

  console.log(`Found ${reportFiles.length} report files to aggregate.`);

  let targetUrl = '';
  let totalRequests = 0;
  let successCount = 0;
  let failureCount = 0;
  let requestsPerSecond = 0;
  let concurrencyLimit = 0;
  let maxDuration = 0;

  let minLatency = Infinity;
  let maxLatency = -Infinity;

  // We will compute weighted averages for avg, median, p95, p99
  let weightedAvgSum = 0;
  let weightedMedianSum = 0;
  let weightedP95Sum = 0;
  let weightedP99Sum = 0;
  let totalLatencyWeight = 0;

  const mergedStatusCodes = {};
  const mergedErrors = {};

  for (const file of reportFiles) {
    const filePath = path.join(dir, file);
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);

    targetUrl = data.targetUrl;
    totalRequests += data.totalRequests;
    successCount += data.successCount;
    failureCount += data.failureCount;
    requestsPerSecond += data.requestsPerSecond;
    concurrencyLimit += data.concurrencyLimit;
    
    if (data.durationSeconds > maxDuration) {
      maxDuration = data.durationSeconds;
    }

    const completed = data.totalRequests;
    if (completed > 0) {
      const stats = data.latencyStatsMs || {};
      minLatency = Math.min(minLatency, stats.min ?? Infinity);
      maxLatency = Math.max(maxLatency, stats.max ?? -Infinity);

      weightedAvgSum += (stats.avg || 0) * completed;
      weightedMedianSum += (stats.median || 0) * completed;
      weightedP95Sum += (stats.p95 || 0) * completed;
      weightedP99Sum += (stats.p99 || 0) * completed;
      totalLatencyWeight += completed;
    }

    // Merge status codes
    if (data.statusCodes) {
      for (const [code, count] of Object.entries(data.statusCodes)) {
        mergedStatusCodes[code] = (mergedStatusCodes[code] || 0) + count;
      }
    }

    // Merge errors
    if (data.errors) {
      for (const [err, count] of Object.entries(data.errors)) {
        mergedErrors[err] = (mergedErrors[err] || 0) + count;
      }
    }
  }

  // Handle case where no requests were completed at all
  if (minLatency === Infinity) minLatency = 0;
  if (maxLatency === -Infinity) maxLatency = 0;

  const finalAvg = totalLatencyWeight > 0 ? Math.round(weightedAvgSum / totalLatencyWeight) : 0;
  const finalMedian = totalLatencyWeight > 0 ? Math.round(weightedMedianSum / totalLatencyWeight) : 0;
  const finalP95 = totalLatencyWeight > 0 ? Math.round(weightedP95Sum / totalLatencyWeight) : 0;
  const finalP99 = totalLatencyWeight > 0 ? Math.round(weightedP99Sum / totalLatencyWeight) : 0;

  const aggregatedReport = {
    targetUrl,
    totalRequests,
    concurrencyLimit,
    durationSeconds: parseFloat(maxDuration.toFixed(2)),
    requestsPerSecond: parseFloat(requestsPerSecond.toFixed(2)),
    successCount,
    failureCount,
    latencyStatsMs: {
      min: minLatency,
      max: maxLatency,
      avg: finalAvg,
      median: finalMedian,
      p95: finalP95,
      p99: finalP99
    },
    statusCodes: mergedStatusCodes,
    errors: mergedErrors
  };

  // Print results beautifully to the console
  console.log('\n==============================================');
  console.log('         CONSOLIDATED PERFORMANCE REPORT       ');
  console.log('==============================================');
  console.log(`Target URL:        ${targetUrl}`);
  console.log(`Total Requests:    ${totalRequests}`);
  console.log(`Concurrency Limit: ${concurrencyLimit} (Combined)`);
  console.log(`Duration Seconds:  ${aggregatedReport.durationSeconds}s`);
  console.log(`Requests/Sec:      ${aggregatedReport.requestsPerSecond}`);
  console.log(`Success Rate:      ${totalRequests > 0 ? ((successCount / totalRequests) * 100).toFixed(1) : 0}%`);
  console.log(`Min Latency:       ${minLatency}ms`);
  console.log(`Max Latency:       ${maxLatency}ms`);
  console.log(`Avg Latency:       ${finalAvg}ms`);
  console.log(`Median Latency:    ${finalMedian}ms`);
  console.log(`p95 Latency:       ${finalP95}ms`);
  console.log(`p99 Latency:       ${finalP99}ms`);

  if (Object.keys(mergedStatusCodes).length > 0) {
    console.log(`\nHTTP Status Code Distribution:`);
    for (const [code, count] of Object.entries(mergedStatusCodes)) {
      console.log(`  - Status ${code}: ${count}`);
    }
  }

  if (Object.keys(mergedErrors).length > 0) {
    console.log(`\nErrors Breakdown:`);
    for (const [errMsg, count] of Object.entries(mergedErrors)) {
      console.log(`  - ${errMsg}: ${count}`);
    }
  }
  console.log('==============================================');

  // Write to final summary-report.json
  const finalReportPath = path.join(dir, 'summary-report.json');
  await fs.writeFile(finalReportPath, JSON.stringify(aggregatedReport, null, 2), 'utf-8');
  console.log(`Aggregated report written to: ${finalReportPath}`);

  // Clean up individual report files
  console.log('\nCleaning up individual PID-based report files...');
  for (const file of reportFiles) {
    const filePath = path.join(dir, file);
    await fs.unlink(filePath);
  }
  console.log('Cleanup completed successfully!');
}

aggregate().catch(err => {
  console.error('Fatal error during aggregation:', err);
});
