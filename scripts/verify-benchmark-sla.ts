import * as fs from 'fs';
import * as path from 'path';

interface LatencyPercentiles {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  avg: number;
}

interface BenchmarkSectionResult {
  totalOps: number;
  durationMs: number;
  opsPerSec: number;
  latencies: LatencyPercentiles;
}

interface BenchmarkReport {
  timestamp: string;
  environment: string;
  placeBenchmark: BenchmarkSectionResult;
  cancelBenchmark: BenchmarkSectionResult;
  mixedWorkloadBenchmark: BenchmarkSectionResult;
}

interface SlaRequirement {
  name: string;
  sectionKey: keyof Omit<BenchmarkReport, 'timestamp' | 'environment'>;
  minOpsPerSec: number;
  maxP95Ms: number;
}

const SLA_REQUIREMENTS: SlaRequirement[] = [
  {
    name: 'Order Placement Workload',
    sectionKey: 'placeBenchmark',
    minOpsPerSec: 5000,
    maxP95Ms: 500,
  },
  {
    name: 'Order Cancellation Workload',
    sectionKey: 'cancelBenchmark',
    minOpsPerSec: 3000,
    maxP95Ms: 500,
  },
  {
    name: 'Mixed Workload (70/20/10)',
    sectionKey: 'mixedWorkloadBenchmark',
    minOpsPerSec: 3000,
    maxP95Ms: 600,
  },
];

function runSlaVerification() {
  const artifactPath = path.join(process.cwd(), 'benchmark-results.json');

  console.log(`\n==================================================`);
  console.log(`🔍 PERFORMANCE BENCHMARK SLA VERIFIER`);
  console.log(`==================================================\n`);

  if (!fs.existsSync(artifactPath)) {
    console.error(`❌ ERROR: Benchmark artifact not found at ${artifactPath}`);
    console.error(
      `   Please run 'npm run benchmark' before executing SLA verification.\n`,
    );
    process.exit(1);
  }

  const rawData = fs.readFileSync(artifactPath, 'utf-8');
  let report: BenchmarkReport;

  try {
    report = JSON.parse(rawData) as BenchmarkReport;
  } catch (err) {
    console.error(
      `❌ ERROR: Failed to parse benchmark JSON artifact: ${(err as Error).message}`,
    );
    process.exit(1);
  }

  let hasViolations = false;

  console.log(`Timestamp:   ${report.timestamp}`);
  console.log(`Environment: ${report.environment}\n`);

  for (const sla of SLA_REQUIREMENTS) {
    const section = report[sla.sectionKey];

    console.log(`--------------------------------------------------`);
    console.log(`📌 ${sla.name}`);
    console.log(
      `   Throughput: ${section.opsPerSec} ops/sec (Target: >= ${sla.minOpsPerSec} ops/sec)`,
    );
    console.log(
      `   p95 Latency: ${section.latencies.p95} ms (Target: <= ${sla.maxP95Ms} ms)`,
    );

    const opsPassed = section.opsPerSec >= sla.minOpsPerSec;
    const latencyPassed = section.latencies.p95 <= sla.maxP95Ms;

    if (!opsPassed) {
      console.error(
        `   ❌ FAIL: Throughput ${section.opsPerSec} ops/sec below target ${sla.minOpsPerSec} ops/sec`,
      );
      hasViolations = true;
    }

    if (!latencyPassed) {
      console.error(
        `   ❌ FAIL: p95 Latency ${section.latencies.p95} ms exceeded threshold ${sla.maxP95Ms} ms`,
      );
      hasViolations = true;
    }

    if (opsPassed && latencyPassed) {
      console.log(`   ✅ PASS: Meets all SLA targets`);
    }
  }

  console.log(`\n==================================================`);

  if (hasViolations) {
    console.error(
      `❌ SLA VERIFICATION FAILED: Performance regression detected.`,
    );
    console.error(`==================================================\n`);
    process.exit(1);
  }

  console.log(`✅ SLA VERIFICATION PASSED: All performance gates satisfied!`);
  console.log(`==================================================\n`);
}

runSlaVerification();
