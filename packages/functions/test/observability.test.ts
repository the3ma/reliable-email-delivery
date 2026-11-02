import { describe, expect, it, vi } from 'vitest';
import { captureOutput, powertoolsTelemetry, testLog } from './helpers.js';

describe('PowertoolsTelemetry.flush', () => {
  it('publishes nothing, and prints nothing, when no metric was counted', () => {
    const { telemetry, metrics } = powertoolsTelemetry(testLog());
    const publish = vi.spyOn(metrics, 'publishStoredMetrics');
    const output = captureOutput();
    telemetry.flush();
    expect(publish).not.toHaveBeenCalled();
    expect(output.text()).toBe('');
  });

  it('publishes the counted metrics once, as one EMF line', () => {
    const { telemetry, metrics } = powertoolsTelemetry(testLog());
    const publish = vi.spyOn(metrics, 'publishStoredMetrics');
    const output = captureOutput();
    telemetry.count('Bounces');
    telemetry.flush();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(metrics.hasStoredMetrics()).toBe(false);
    expect(output.lines()).toHaveLength(1);
    expect(output.text()).toContain('"Bounces"');
  });
});
