const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaultFx, validateFx, delayFeedback, delaySeconds } = require('../public/player/effects.js');
const { createProject, projectData, validateProject, sliceClip, glueClips } = require('../public/player/project.js');

test('delay decays to -60 dB after the selected number of repeats; zero bypasses', () => {
  assert.equal(delayFeedback(0), 0);
  for (const count of [1, 2, 8, 16]) assert.ok(Math.abs(delayFeedback(count) ** count - .001) < 1e-12);
});

test('delay time supports milliseconds and tempo sync within the graph capacity', () => {
  assert.equal(delaySeconds(defaultFx(), 90), .333);
  for (const [sync, seconds] of [['1/16', .125], ['1/8', .25], ['1/4', .5], ['1/2', 1]]) {
    assert.equal(delaySeconds({ ...defaultFx(), sync }, 120), seconds);
  }
  assert.equal(delaySeconds({ ...defaultFx(), sync: '1/2' }, 40), 2);
});

test('effects reject non-finite values, excessive feedback counts and invalid options', () => {
  assert.deepEqual(validateFx(defaultFx()), defaultFx());
  for (const bad of [{ gain: NaN }, { pan: 2 }, { low: -13 }, { mid: Infinity }, { high: 13 }, { dRep: 1.5 }, { dRep: 17 }, { dMix: 1.1 }, { dTime: 0 }, { sync: '1/3' }, { pingPong: 'yes' }]) {
    assert.throws(() => validateFx({ ...defaultFx(), ...bad }), /Invalid project/);
  }
});

test('lane defaults and clip overrides survive JSON without sharing mutable objects', () => {
  const project = createProject(), pattern = project.patterns[0];
  project.arrangement.lanes[0].fx = { ...defaultFx(), gain: -6, dRep: 4, sync: '1/8' };
  const clip = { id: 'fx-clip', kind: 'pattern', ref: pattern.id, lane: 0, start: 0, length: 2, loopLength: 2, trimStart: 0, offsetMs: 17, fadeIn: 0, fadeOut: 0, fx: { ...defaultFx(), pan: -.4, pingPong: true } };
  project.arrangement.clips.push(clip);
  const restored = validateProject(JSON.parse(JSON.stringify(projectData(project))), []);
  assert.deepEqual(restored.arrangement.lanes[0].fx, project.arrangement.lanes[0].fx);
  assert.deepEqual(restored.arrangement.clips[0].fx, clip.fx);
  restored.arrangement.clips[0].fx.pan = .5;
  assert.equal(clip.fx.pan, -.4);
  const parts = sliceClip(clip, 1);
  assert.deepEqual(glueClips(parts).fx, clip.fx);
  parts[1].fx = { ...clip.fx, gain: -12 };
  assert.throws(() => glueClips(parts), /effects/);
  const invalid = projectData(project); invalid.arrangement.lanes[0].fx.dRep = 1.2;
  assert.throws(() => validateProject(invalid, []), /effect/);
});
