import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  MAX_FIX_ITERATIONS_CEILING,
  validateReviewPipelineSettings,
} from '../../src/config/schema.js';
import { ConfigError } from '../../src/utils/errors.js';

describe('reviewPipeline settings (Feature 2 — Phase 3)', () => {
  it('defaults match the Section 2 authoritative resolver weights', () => {
    expect(DEFAULT_SETTINGS.reviewPipeline.resolverWeights).toEqual({
      ba: 0.2,
      dev: 0.3,
      sec: 0.3,
      qa: 0.15,
      pm: 0.05,
      buildFailure: 0.4,
    });
  });

  it('defaults maxFixIterations to the hard ceiling (5)', () => {
    expect(DEFAULT_SETTINGS.reviewPipeline.maxFixIterations).toBe(5);
    expect(MAX_FIX_ITERATIONS_CEILING).toBe(5);
  });

  it('accepts the default settings as valid', () => {
    expect(() => validateReviewPipelineSettings(DEFAULT_SETTINGS.reviewPipeline)).not.toThrow();
  });

  it('rejects maxFixIterations above the hard ceiling', () => {
    expect(() =>
      validateReviewPipelineSettings({
        resolverWeights: DEFAULT_SETTINGS.reviewPipeline.resolverWeights,
        maxFixIterations: 6,
      }),
    ).toThrow(ConfigError);
  });

  it('rejects maxFixIterations below 1', () => {
    expect(() =>
      validateReviewPipelineSettings({
        resolverWeights: DEFAULT_SETTINGS.reviewPipeline.resolverWeights,
        maxFixIterations: 0,
      }),
    ).toThrow(ConfigError);
  });

  it('rejects a negative resolver weight', () => {
    expect(() =>
      validateReviewPipelineSettings({
        resolverWeights: { ba: -0.1, dev: 0.3, sec: 0.3, qa: 0.15, pm: 0.05, buildFailure: 0.4 },
        maxFixIterations: 5,
      }),
    ).toThrow(ConfigError);
  });
});
