import test from 'node:test'
import assert from 'node:assert/strict'
import { importPreset, serializePreset } from '../../src/cardcodec.ts'
import { normalizeConfig } from '../../src/config.ts'

test('cleared preset fields stay absent on export while unknown fields survive', () => {
  const mappings = {
    maxTokens: 'max_tokens', temperature: 'temp', topP: 'top_p', topK: 'top_k',
    topA: 'top_a', typicalP: 'typical_p', minP: 'min_p', repPen: 'rep_pen',
    repPenRange: 'rep_pen_range', repPenSlope: 'rep_pen_slope',
    presencePenalty: 'presence_penalty', frequencyPenalty: 'frequency_penalty',
  }
  const raw = Object.fromEntries(Object.values(mappings).map(key => [key, 1]))
  const preset = importPreset({ ...raw, custom_model: 'old', custom_extension: { keep: true } }, 'p', 'P')
  for (const key of Object.keys(mappings)) delete preset[key]
  delete preset.model
  const exported = serializePreset(preset)
  for (const key of [...Object.values(mappings), 'custom_model']) {
    assert.equal(Object.hasOwn(exported, key), false, `${key} must stay cleared`)
  }
  assert.deepEqual(exported.custom_extension, { keep: true })
  preset.temperature = 0.7
  preset.model = 'new'
  const updated = serializePreset(preset)
  assert.equal(updated.temp, 0.7)
  assert.equal(updated.custom_model, 'new')
})

test('absent config merges the environment allowlist and returns independent arrays', () => {
  const old = process.env.DSH_TAVERN_ALLOWED_HOSTS
  try {
    process.env.DSH_TAVERN_ALLOWED_HOSTS = ' Tavern.Example, second.example '
    for (const input of [undefined, null, {}]) {
      assert.deepEqual(normalizeConfig(input).allowedHosts, ['tavern.example', 'second.example'])
    }
    assert.deepEqual(normalizeConfig({ allowedHosts: ['TAVERN.EXAMPLE', 'third.example'] }).allowedHosts,
      ['tavern.example', 'third.example', 'second.example'])
    delete process.env.DSH_TAVERN_ALLOWED_HOSTS
    const a = normalizeConfig(undefined)
    a.allowedHosts.push('mutated')
    assert.deepEqual(normalizeConfig(undefined).allowedHosts, [])
  } finally {
    if (old === undefined) delete process.env.DSH_TAVERN_ALLOWED_HOSTS
    else process.env.DSH_TAVERN_ALLOWED_HOSTS = old
  }
})
