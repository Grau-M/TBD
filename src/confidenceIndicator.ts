// src/confidenceIndicator.ts
export type ConfidenceLabel = 'High' | 'Medium' | 'Low';

export interface ConfidenceResult {
  label: ConfidenceLabel;
  score: number;              // 0–100 (easy to explain)
  reasons: string[];          // human-readable
  flags: string[];            // short tags for UI
  stats: {
    eventCount: number;
    pauseCount: number;
    maxGapMinutes: number;
    gapCountOver30m: number;
    gapCountOver2h: number;
    integrityWarnings: number;
  };
}

function minutes(ms: number) {
  return Math.round(ms / 60000);
}

export function computeConfidence(events: any[]): ConfidenceResult {
  // Defaults
  let score = 100;
  const reasons: string[] = [];
  const flags: string[] = [];

  // 1) Basic counts
  const eventCount = Array.isArray(events) ? events.length : 0;

  // If no events, confidence must be low
  if (eventCount === 0) {
    return {
      label: 'Low',
      score: 0,
      reasons: ['No activity events were found in the log.'],
      flags: ['NO_DATA'],
      stats: {
        eventCount: 0,
        pauseCount: 0,
        maxGapMinutes: 0,
        gapCountOver30m: 0,
        gapCountOver2h: 0,
        integrityWarnings: 0
      }
    };
  }

  // 2) Extract timestamps (expects event.time as ISO-ish string)
  const times: number[] = [];
  let pauseCount = 0;
  let integrityWarnings = 0;

  for (const e of events) {
    if (typeof e?.time === 'string') {
      const t = Date.parse(e.time.replace(' ', 'T'));
      if (!Number.isNaN(t)) times.push(t);
    }

    // Pause markers from your interruption tracker use fileView prefix
    const fv = String(e?.fileView ?? '');
    if (fv.startsWith('[INTERRUPTION] Session Paused')) pauseCount++;

    // Integrity warnings (if you already log these anywhere)
    const p = String(e?.possibleAiDetection ?? '');
    if (p.toLowerCase().includes('corrupt') || p.toLowerCase().includes('tamper') || p.toLowerCase().includes('integrity')) {
      integrityWarnings++;
    }
  }

  times.sort((a, b) => a - b);

  // 3) Compute gaps
  let maxGapMs = 0;
  let gapCountOver30m = 0;
  let gapCountOver2h = 0;

  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > maxGapMs) maxGapMs = gap;
    if (gap >= 30 * 60 * 1000) gapCountOver30m++;
    if (gap >= 2 * 60 * 60 * 1000) gapCountOver2h++;
  }

  // 4) Scoring rules (simple + defensible)
  if (eventCount < 50) {
    score -= 25;
    reasons.push('Very low activity volume recorded (limited evidence).');
    flags.push('LOW_VOLUME');
  } else if (eventCount < 200) {
    score -= 10;
    reasons.push('Moderate activity volume (evidence is usable but not extensive).');
    flags.push('MED_VOLUME');
  }

  if (gapCountOver2h >= 1) {
    score -= 25;
    reasons.push(`Large inactivity gaps detected (max gap: ${minutes(maxGapMs)} minutes).`);
    flags.push('LARGE_GAPS');
  } else if (gapCountOver30m >= 2) {
    score -= 15;
    reasons.push('Multiple inactivity gaps over 30 minutes detected.');
    flags.push('MED_GAPS');
  }

  if (pauseCount >= 8) {
    score -= 15;
    reasons.push(`Frequent session pauses detected (${pauseCount}).`);
    flags.push('FREQ_PAUSES');
  } else if (pauseCount >= 3) {
    score -= 8;
    reasons.push(`Some session pauses detected (${pauseCount}).`);
    flags.push('SOME_PAUSES');
  }

  if (integrityWarnings > 0) {
    score -= 35;
    reasons.push('Integrity warnings were detected in the log.');
    flags.push('INTEGRITY_WARNING');
  }

  // Clamp score
  score = Math.max(0, Math.min(100, score));

  // 5) Label from score
  let label: ConfidenceLabel = 'High';
  if (score < 45) label = 'Low';
  else if (score < 75) label = 'Medium';

  // Always ensure at least one reason
  if (reasons.length === 0) {
    reasons.push('Log appears complete with minimal gaps or warnings.');
    flags.push('OK');
  }

  return {
    label,
    score,
    reasons,
    flags,
    stats: {
      eventCount,
      pauseCount,
      maxGapMinutes: minutes(maxGapMs),
      gapCountOver30m,
      gapCountOver2h,
      integrityWarnings
    }
  };
}