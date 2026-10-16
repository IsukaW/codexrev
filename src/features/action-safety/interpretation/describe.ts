// Plain-text description of an interpretation result, for the CLI. Moved out of the command
// handler so the assessment report can use it without a circular import. Never calls the
// model's output a finding, a verdict or evidence.

import type { ContextInterpretation } from './types.js';

const MAX_OBSERVATIONS_SHOWN = 10;

export function describeInterpretation(i: ContextInterpretation): string[] {
  const lines: string[] = [];
  const via = i.provider ? ` (model "${i.provider.model}" via ${i.provider.id}${i.provider.local ? ', local' : ', NOT local'})` : '';
  if (i.status !== 'COMPLETED') {
    lines.push(`status: ${i.status}${via}`);
    if (i.reason) lines.push(`reason: ${i.reason}`);
    lines.push('no observations were produced, and none were invented');
    return lines;
  }
  lines.push(`status: COMPLETED${via}`);
  if (i.summary) lines.push(`model summary (unverified): ${i.summary}`);
  lines.push(`${i.observations.length} observation(s), none of them verified:`);
  for (const o of i.observations.slice(0, MAX_OBSERVATIONS_SHOWN)) {
    lines.push(`  [${o.significance}] ${o.category} (${o.kind === 'concern' ? 'concern' : 'information gap'}): ${o.description}` + (o.references.length > 0 ? `  refs: ${o.references.join(', ')}` : ''));
  }
  if (i.observations.length > MAX_OBSERVATIONS_SHOWN) lines.push(`  ... and ${i.observations.length - MAX_OBSERVATIONS_SHOWN} more`);
  if (i.rejectedObservations.length > 0) lines.push(`${i.rejectedObservations.length} observation(s) dropped for citing evidence that does not exist`);
  if (i.injectionIndicators.length > 0) lines.push(`possible prompt-injection text found in ${i.injectionIndicators.length} place(s); it was treated as data`);
  return lines;
}
