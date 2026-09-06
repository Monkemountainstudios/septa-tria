'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Pause, Play, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';

type VisualEvent = { id: number; x: number; y: number; hue: number; size: number; variant: number; pull: number; orbit: number; midi: number; sampleId: string };
type Point = { x: number; y: number };
type Segment = { from: Point; to: Point };
type FieldBall = { id: 'inner' | 'outer-a' | 'outer-b'; zone: 'inner' | 'outer'; x: number; y: number; vx: number; vy: number; radius: number; hue: number; boost: number };
type MirrorSurface = { id: string; path: Path2D; clip?: Path2D };
type ActiveVoice = { source: AudioBufferSourceNode; level: GainNode; panner: StereoPannerNode };
type ReverbBus = { input: GainNode; output: GainNode };
type ChorusBus = ReverbBus & { modulators: OscillatorNode[]; shimmerSend: GainNode | null };
type AudioState = { context: AudioContext | null; buffers: Map<string, AudioBuffer>; loads: Map<string, Promise<AudioBuffer | null>>; voices: Map<number, Set<ActiveVoice>>; roomBus: ReverbBus | null; chorusBus: ChorusBus | null; shimmerBus: ReverbBus | null; shimmerSources: Set<AudioBufferSourceNode>; delayedSources: Set<AudioBufferSourceNode>; delayOutputs: Set<GainNode> };
const TAU = Math.PI * 2;
const CENTRIFUGAL_DRIFT = 0.0006;
const TARGET_FRAME_MS = 1000 / 30;
const spriteCache = new Map<string, HTMLCanvasElement>();
const PALETTE = [178, 203, 270, 318, 34, 146];
const SCALES = {
  minorPentatonic: { label: 'Minor pentatonic', intervals: [0, 3, 5, 7, 10] },
  major: { label: 'Major', intervals: [0, 2, 4, 5, 7, 9, 11] },
  minor: { label: 'Minor', intervals: [0, 2, 3, 5, 7, 8, 10] },
  dorian: { label: 'Dorian', intervals: [0, 2, 3, 5, 7, 9, 10] },
  lydian: { label: 'Lydian', intervals: [0, 2, 4, 6, 7, 9, 11] },
  mixolydian: { label: 'Mixolydian', intervals: [0, 2, 4, 5, 7, 9, 10] },
  pentatonic: { label: 'Pentatonic', intervals: [0, 2, 4, 7, 9] },
  ragatodi: { label: 'Ragatodi', intervals: [0, 1, 3, 6, 7, 9, 10, 11] },
  wholetone: { label: 'Whole tone', intervals: [0, 2, 4, 6, 8, 10] },
} as const;
type ScaleName = keyof typeof SCALES;
const INITIAL_EVENTS: VisualEvent[] = [];

function initialBalls(): FieldBall[] {
  return [
    { id: 'inner', zone: 'inner', x: -0.08, y: 0.04, vx: 0.0372, vy: 0.0264, radius: 4.5, hue: 278, boost: 1 },
    { id: 'outer-a', zone: 'outer', x: 0.39, y: -0.12, vx: -0.056, vy: 0.068, radius: 5, hue: 184, boost: 1 },
    { id: 'outer-b', zone: 'outer', x: -0.38, y: 0.14, vx: 0.066, vy: -0.055, radius: 4.7, hue: 198, boost: 1 },
  ];
}

function pitchForY(y: number, scaleName: ScaleName) {
  const normalized = Math.max(0, Math.min(1, (0.57 - y) / 1.14));
  const intervals = SCALES[scaleName].intervals;
  const notes = [0, 1].flatMap((octave) => intervals.map((interval) => 48 + octave * 12 + interval)).concat(72);
  return notes[Math.round(normalized * (notes.length - 1))];
}

function spatialAudioFor(event: VisualEvent) {
  const radius = Math.hypot(event.x, event.y);
  return {
    level: 1 - Math.min(radius / 0.57, 1) * 0.7,
    pan: Math.max(-0.95, Math.min(0.95, event.x / 0.57)),
  };
}

function createShimmerImpulse(context: AudioContext) {
  const duration = 4.2, length = Math.floor(context.sampleRate * duration);
  const impulse = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      const progress = index / length;
      const decay = (1 - progress) ** 2.35;
      const sparkle = 0.64 + Math.sin(index * (0.017 + channel * 0.0023)) * 0.22;
      data[index] = (Math.random() * 2 - 1) * decay * sparkle;
    }
  }
  return impulse;
}

function createRoomImpulse(context: AudioContext) {
  const duration = 0.72, length = Math.floor(context.sampleRate * duration);
  const impulse = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      const progress = index / length;
      data[index] = (Math.random() * 2 - 1) * (1 - progress) ** 3.4;
    }
  }
  return impulse;
}

function ensureRoomBus(context: AudioContext, state: AudioState) {
  if (state.roomBus) return state.roomBus;
  const input = context.createGain(), highpass = context.createBiquadFilter(), convolver = context.createConvolver();
  const tone = context.createBiquadFilter(), output = context.createGain();
  highpass.type = 'highpass'; highpass.frequency.value = 180;
  convolver.buffer = createRoomImpulse(context);
  tone.type = 'lowpass'; tone.frequency.value = 5600;
  output.gain.value = 0.15;
  input.connect(highpass).connect(convolver).connect(tone).connect(output).connect(context.destination);
  state.roomBus = { input, output };
  return state.roomBus;
}

function ensureChorusBus(context: AudioContext, state: AudioState) {
  if (state.chorusBus) return state.chorusBus;
  const input = context.createGain(), output = context.createGain();
  const delays = [context.createDelay(0.06), context.createDelay(0.06)];
  const pans = [context.createStereoPanner(), context.createStereoPanner()];
  const modulators = [context.createOscillator(), context.createOscillator()];
  delays[0].delayTime.value = 0.016; delays[1].delayTime.value = 0.023;
  pans[0].pan.value = -0.62; pans[1].pan.value = 0.62;
  output.gain.value = 0.38;
  delays.forEach((delay, index) => {
    const depth = context.createGain();
    depth.gain.value = index === 0 ? 0.0038 : 0.0047;
    modulators[index].frequency.value = index === 0 ? 0.17 : 0.23;
    modulators[index].connect(depth).connect(delay.delayTime);
    input.connect(delay).connect(pans[index]).connect(output);
    modulators[index].start();
  });
  output.connect(context.destination);
  state.chorusBus = { input, output, modulators, shimmerSend: null };
  return state.chorusBus;
}

function ensureShimmerBus(context: AudioContext, state: AudioState) {
  if (state.shimmerBus) return state.shimmerBus;
  const input = context.createGain(), highpass = context.createBiquadFilter(), predelay = context.createDelay(0.2);
  const convolver = context.createConvolver(), tone = context.createBiquadFilter(), output = context.createGain();
  highpass.type = 'highpass'; highpass.frequency.value = 1050; highpass.Q.value = 0.55;
  predelay.delayTime.value = 0.065;
  convolver.buffer = createShimmerImpulse(context);
  tone.type = 'lowpass'; tone.frequency.value = 10500;
  output.gain.value = 0.48;
  input.connect(highpass).connect(predelay).connect(convolver).connect(tone).connect(output).connect(context.destination);
  state.shimmerBus = { input, output };
  return state.shimmerBus;
}

function setChorusShimmerSend(context: AudioContext, chorusBus: ChorusBus, shimmerBus: ReverbBus, amount: number) {
  if (!chorusBus.shimmerSend) {
    chorusBus.shimmerSend = context.createGain();
    chorusBus.shimmerSend.gain.value = 0;
    chorusBus.output.connect(chorusBus.shimmerSend).connect(shimmerBus.input);
  }
  chorusBus.shimmerSend.gain.setTargetAtTime(Math.max(0, Math.min(0.16, amount)), context.currentTime, 0.08);
}

function rotate(point: Point, angle: number): Point {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
}

function reflectAcross(point: Point, axis: number): Point {
  const local = rotate(point, -axis);
  return rotate({ x: local.x, y: -local.y }, axis);
}

function mirrorCopies(event: VisualEvent, folds: number, axisAngle: number, reverseOrientation = false) {
  const source = reverseOrientation ? { x: -event.x, y: event.y } : event;
  const copies: { point: Point; reflected: boolean; original: boolean }[] = [];
  for (let index = 0; index < folds; index += 1) {
    copies.push({ point: rotate(source, (index * TAU) / folds), reflected: reverseOrientation, original: !reverseOrientation && index === 0 });
    copies.push({ point: reflectAcross(source, axisAngle + (index * Math.PI) / folds), reflected: !reverseOrientation, original: false });
  }
  return copies;
}

function reflectionChorusAmount(event: VisualEvent, outerAngle: number, innerAngle: number) {
  const reflectedPoints = [
    ...mirrorCopies(event, 7, outerAngle).filter((copy) => !copy.original),
    ...mirrorCopies(event, 3, innerAngle, true),
  ];
  const meanDistance = reflectedPoints.reduce((sum, copy) => sum + Math.hypot(copy.point.x - event.x, copy.point.y - event.y), 0) / reflectedPoints.length;
  return Math.max(0, Math.min(1, meanDistance / 1.15));
}

function copyBrightness(event: VisualEvent, point: Point) {
  const distance = Math.hypot(point.x - event.x, point.y - event.y);
  return Math.max(0.3, 1 - Math.min(distance / 1.15, 1) * 0.7);
}

function rotateAround(point: Point, centre: Point, angle: number): Point {
  const rotated = rotate({ x: point.x - centre.x, y: point.y - centre.y }, angle);
  return { x: centre.x + rotated.x, y: centre.y + rotated.y };
}

function triangleMirrorGeometry(cx: number, cy: number, radius: number, angle: number, bend: number, cornerSpin: number) {
  const vertices = Array.from({ length: 3 }, (_, index) => {
    const vertexAngle = angle - Math.PI / 2 + (index * TAU) / 3;
    return { x: cx + Math.cos(vertexAngle) * radius, y: cy + Math.sin(vertexAngle) * radius };
  });
  const path = new Path2D();
  path.moveTo(vertices[0].x, vertices[0].y);
  for (let index = 0; index < 3; index += 1) {
    const next = vertices[(index + 1) % 3];
    const midpoint = lerpPoint(vertices[index], next, 0.5);
    const dx = midpoint.x - cx, dy = midpoint.y - cy, distance = Math.hypot(dx, dy);
    const control = { x: midpoint.x + (dx / distance) * bend * radius, y: midpoint.y + (dy / distance) * bend * radius };
    path.quadraticCurveTo(control.x, control.y, next.x, next.y);
  }
  path.closePath();
  const corners = vertices.map((vertex, index) => {
    const previous = vertices[(index + 2) % 3], next = vertices[(index + 1) % 3];
    const rawShoulderBefore = lerpPoint(vertex, previous, 0.17);
    const rawShoulderAfter = lerpPoint(vertex, next, 0.17);
    const rawTip = lerpPoint(vertex, { x: cx, y: cy }, 0.19);
    const centre = { x: (rawShoulderBefore.x + rawShoulderAfter.x + rawTip.x) / 3, y: (rawShoulderBefore.y + rawShoulderAfter.y + rawTip.y) / 3 };
    const localSpin = cornerSpin * (index % 2 === 0 ? 1 : -1);
    const shoulderBefore = rotateAround(rawShoulderBefore, centre, localSpin);
    const shoulderAfter = rotateAround(rawShoulderAfter, centre, localSpin);
    const tip = rotateAround(rawTip, centre, localSpin);
    const cornerPath = new Path2D();
    cornerPath.moveTo(shoulderBefore.x, shoulderBefore.y); cornerPath.lineTo(tip.x, tip.y); cornerPath.lineTo(shoulderAfter.x, shoulderAfter.y); cornerPath.closePath();
    return { shoulderBefore, shoulderAfter, tip, path: cornerPath };
  });
  return { path, corners, vertices };
}

function lerpPoint(from: Point, to: Point, amount: number): Point {
  return { x: from.x + (to.x - from.x) * amount, y: from.y + (to.y - from.y) * amount };
}

function reflectAcrossLine(point: Point, lineStart: Point, lineEnd: Point): Point {
  const dx = lineEnd.x - lineStart.x, dy = lineEnd.y - lineStart.y;
  const lengthSquared = dx * dx + dy * dy;
  const projection = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / lengthSquared;
  const projected = { x: lineStart.x + projection * dx, y: lineStart.y + projection * dy };
  return { x: projected.x * 2 - point.x, y: projected.y * 2 - point.y };
}

function linePath(from: Point, to: Point) {
  const path = new Path2D();
  path.moveTo(from.x, from.y); path.lineTo(to.x, to.y);
  return path;
}

function closestBoundaryHit(point: Point, boundary: Point[]) {
  let closest = boundary[0], tangent = { x: 1, y: 0 }, bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < boundary.length; index += 1) {
    const from = boundary[index], to = boundary[(index + 1) % boundary.length];
    const dx = to.x - from.x, dy = to.y - from.y;
    const lengthSquared = dx * dx + dy * dy;
    const amount = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared));
    const candidate = { x: from.x + dx * amount, y: from.y + dy * amount };
    const distance = Math.hypot(point.x - candidate.x, point.y - candidate.y);
    if (distance < bestDistance) {
      const segmentLength = Math.hypot(dx, dy) || 1;
      bestDistance = distance; closest = candidate; tangent = { x: dx / segmentLength, y: dy / segmentLength };
    }
  }
  return { point: closest, tangent };
}

function bounceBall(
  ball: FieldBall,
  proposed: Point,
  boundary: Point[],
  isValid: (point: Point) => boolean,
  clearance: number,
  boundarySpin: number,
  options: { strongOuter?: boolean; onlyIfApproaching?: boolean } = {},
) {
  const hit = closestBoundaryHit(proposed, boundary);
  let nx = -hit.tangent.y, ny = hit.tangent.x;
  const separation = clearance * 1.6;
  if (!isValid({ x: hit.point.x + nx * separation, y: hit.point.y + ny * separation })) { nx = -nx; ny = -ny }
  if (!isValid({ x: hit.point.x + nx * separation, y: hit.point.y + ny * separation })) {
    for (let index = 0; index < 24; index += 1) {
      const angle = (index * TAU) / 24, candidate = { x: hit.point.x + Math.cos(angle) * separation, y: hit.point.y + Math.sin(angle) * separation };
      if (isValid(candidate)) { nx = Math.cos(angle); ny = Math.sin(angle); break }
    }
  }
  const wallVx = -boundarySpin * hit.point.y, wallVy = boundarySpin * hit.point.x;
  let relativeVx = ball.vx - wallVx, relativeVy = ball.vy - wallVy;
  const approach = relativeVx * nx + relativeVy * ny;
  if (options.onlyIfApproaching && approach >= 0) return false;
  if (approach < 0) {
    relativeVx -= 1.88 * approach * nx; relativeVy -= 1.88 * approach * ny;
  } else {
    relativeVx += (0.008 - Math.min(approach, 0.008)) * nx;
    relativeVy += (0.008 - Math.min(approach, 0.008)) * ny;
  }
  const minimumOutgoing = options.strongOuter ? 0.038 : 0.018;
  const outgoing = relativeVx * nx + relativeVy * ny;
  if (outgoing < minimumOutgoing) { relativeVx += (minimumOutgoing - outgoing) * nx; relativeVy += (minimumOutgoing - outgoing) * ny }
  ball.vx = relativeVx + wallVx; ball.vy = relativeVy + wallVy;
  if (options.strongOuter) {
    const radius = Math.hypot(hit.point.x, hit.point.y) || 1;
    ball.vx -= (hit.point.x / radius) * 0.018;
    ball.vy -= (hit.point.y / radius) * 0.018;
  }
  const speed = Math.hypot(ball.vx, ball.vy), maxSpeed = ball.zone === 'outer' ? 0.34 : 0.065;
  if (speed > maxSpeed) { ball.vx *= maxSpeed / speed; ball.vy *= maxSpeed / speed }
  ball.boost = options.strongOuter ? 1.26 : 1.14;
  ball.x = hit.point.x + nx * separation; ball.y = hit.point.y + ny * separation;
  return true;
}

function bounceBallOffSegments(ball: FieldBall, proposed: Point, segments: Segment[], clearance: number, boundaryVelocity: (point: Point) => Point) {
  let closest: Point | null = null, closestTangent = { x: 1, y: 0 }, bestDistance = Number.POSITIVE_INFINITY;
  for (const segment of segments) {
    const dx = segment.to.x - segment.from.x, dy = segment.to.y - segment.from.y;
    const lengthSquared = dx * dx + dy * dy, length = Math.sqrt(lengthSquared) || 1;
    const amount = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((proposed.x - segment.from.x) * dx + (proposed.y - segment.from.y) * dy) / lengthSquared));
    const point = { x: segment.from.x + dx * amount, y: segment.from.y + dy * amount };
    const distance = Math.hypot(proposed.x - point.x, proposed.y - point.y);
    if (distance < bestDistance) { bestDistance = distance; closest = point; closestTangent = { x: dx / length, y: dy / length } }
  }
  if (!closest || bestDistance > clearance) return false;
  let nx = ball.x - closest.x, ny = ball.y - closest.y;
  const normalLength = Math.hypot(nx, ny);
  if (normalLength < 0.0001) { nx = -closestTangent.y; ny = closestTangent.x }
  else { nx /= normalLength; ny /= normalLength }
  const wallVelocity = boundaryVelocity(closest), wallVx = wallVelocity.x, wallVy = wallVelocity.y;
  const relativeVx = ball.vx - wallVx, relativeVy = ball.vy - wallVy;
  const approach = relativeVx * nx + relativeVy * ny;
  if (approach >= 0) return false;
  let bouncedVx = relativeVx - 1.88 * approach * nx, bouncedVy = relativeVy - 1.88 * approach * ny;
  const outgoing = bouncedVx * nx + bouncedVy * ny;
  if (outgoing < 0.018) { bouncedVx += (0.018 - outgoing) * nx; bouncedVy += (0.018 - outgoing) * ny }
  ball.vx = bouncedVx + wallVx;
  ball.vy = bouncedVy + wallVy;
  const speed = Math.hypot(ball.vx, ball.vy), maxSpeed = ball.zone === 'outer' ? 0.34 : 0.065;
  if (speed > maxSpeed) { ball.vx *= maxSpeed / speed; ball.vy *= maxSpeed / speed }
  ball.boost = 1.14;
  ball.x = closest.x + nx * clearance; ball.y = closest.y + ny * clearance;
  return true;
}

function ejectBallFromPolygon(ball: FieldBall, points: Point[], clearance: number, boundaryVelocity: (point: Point) => Point, isValid: (point: Point) => boolean) {
  const winding = points.reduce((area, point, index) => {
    const next = points[(index + 1) % points.length];
    return area + point.x * next.y - next.x * point.y;
  }, 0);
  let escape: { point: Point; nx: number; ny: number; distance: number } | null = null;
  let fallback: typeof escape = null;
  const separation = clearance * 1.35;
  for (let index = 0; index < points.length; index += 1) {
    const from = points[index], to = points[(index + 1) % points.length];
    const dx = to.x - from.x, dy = to.y - from.y;
    const lengthSquared = dx * dx + dy * dy, length = Math.sqrt(lengthSquared) || 1;
    const amount = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((ball.x - from.x) * dx + (ball.y - from.y) * dy) / lengthSquared));
    const point = { x: from.x + dx * amount, y: from.y + dy * amount };
    const distance = Math.hypot(ball.x - point.x, ball.y - point.y);
    const nx = winding >= 0 ? dy / length : -dy / length;
    const ny = winding >= 0 ? -dx / length : dx / length;
    const candidate = { x: point.x + nx * separation, y: point.y + ny * separation };
    const option = { point, nx, ny, distance };
    if (!fallback || distance < fallback.distance) fallback = option;
    if (isValid(candidate) && (!escape || distance < escape.distance)) escape = option;
  }
  const hit = escape ?? fallback;
  if (!hit) return;
  const wallVelocity = boundaryVelocity(hit.point);
  let relativeVx = ball.vx - wallVelocity.x, relativeVy = ball.vy - wallVelocity.y;
  const approach = relativeVx * hit.nx + relativeVy * hit.ny;
  if (approach < 0) {
    relativeVx -= 1.88 * approach * hit.nx;
    relativeVy -= 1.88 * approach * hit.ny;
  }
  const outgoing = relativeVx * hit.nx + relativeVy * hit.ny;
  if (outgoing < 0.018) {
    relativeVx += (0.018 - outgoing) * hit.nx;
    relativeVy += (0.018 - outgoing) * hit.ny;
  }
  ball.vx = relativeVx + wallVelocity.x;
  ball.vy = relativeVy + wallVelocity.y;
  const speed = Math.hypot(ball.vx, ball.vy), maxSpeed = ball.zone === 'outer' ? 0.34 : 0.065;
  if (speed > maxSpeed) { ball.vx *= maxSpeed / speed; ball.vy *= maxSpeed / speed }
  ball.boost = 1.14;
  ball.x = hit.point.x + hit.nx * separation;
  ball.y = hit.point.y + hit.ny * separation;
}

function outerMirrorGeometry(cx: number, cy: number, radius: number, angle: number) {
  const vertices = Array.from({ length: 7 }, (_, index) => {
    const vertexAngle = angle - Math.PI / 2 + (index * TAU) / 7;
    return { x: cx + Math.cos(vertexAngle) * radius, y: cy + Math.sin(vertexAngle) * radius };
  });
  const joints = vertices.map((vertex, index) => {
    const previous = vertices[(index + 6) % 7], next = vertices[(index + 1) % 7];
    const shoulderBefore = lerpPoint(vertex, previous, 0.13);
    const shoulderAfter = lerpPoint(vertex, next, 0.13);
    const direction = { x: (vertex.x - cx) / radius, y: (vertex.y - cy) / radius };
    const isLong = index % 2 === 0;
    const depth = radius * (isLong ? 0.32 : 0.11);
    const tip = { x: vertex.x - direction.x * depth, y: vertex.y - direction.y * depth };
    const path = new Path2D();
    path.moveTo(shoulderBefore.x, shoulderBefore.y); path.lineTo(tip.x, tip.y); path.lineTo(shoulderAfter.x, shoulderAfter.y); path.closePath();
    return { shoulderBefore, shoulderAfter, tip, path, isLong };
  });
  const path = new Path2D();
  const boundary: Point[] = [];
  joints.forEach((joint, index) => {
    if (index === 0) path.moveTo(joint.shoulderBefore.x, joint.shoulderBefore.y);
    else path.lineTo(joint.shoulderBefore.x, joint.shoulderBefore.y);
    path.lineTo(joint.tip.x, joint.tip.y);
    path.lineTo(joint.shoulderAfter.x, joint.shoulderAfter.y);
    boundary.push(joint.shoulderBefore, joint.tip, joint.shoulderAfter);
  });
  path.closePath();
  return { path, joints, boundary };
}

function snowflakeSprite(event: VisualEvent, original: boolean) {
  const key = `${event.id}-${event.hue}-${event.size}-${event.variant}-${original}`;
  const cached = spriteCache.get(key);
  if (cached) return cached;
  const radius = (10 + event.size * 8) * (original ? 1.08 : 1);
  const arms = event.variant < 0.16 ? 5 : event.variant > 0.86 ? 7 : 6;
  const missingArm = event.variant > 0.3 && event.variant < 0.44 ? Math.floor(event.variant * 100) % arms : -1;
  const padding = original ? 20 : 15;
  const size = Math.ceil((radius + padding) * 2);
  const sprite = document.createElement('canvas');
  sprite.width = size; sprite.height = size;
  const context = sprite.getContext('2d');
  if (!context) return sprite;
  context.translate(size / 2, size / 2);
  context.strokeStyle = `hsl(${event.hue} 88% 68%)`; context.fillStyle = `hsl(${event.hue} 94% 74%)`;
  context.shadowColor = `hsl(${event.hue} 95% 60%)`; context.shadowBlur = original ? 14 : 9;
  context.lineWidth = original ? 1.35 : 0.9; context.beginPath();
  for (let index = 0; index < arms; index += 1) {
    if (index === missingArm) continue;
    const angle = (index * TAU) / arms;
    const irregular = 1 + Math.sin((index + 1) * (event.variant * 11 + 2.3)) * 0.055;
    const tipX = Math.cos(angle) * radius * irregular, tipY = Math.sin(angle) * radius * irregular;
    context.moveTo(0, 0); context.lineTo(tipX, tipY);
    const branch = radius * (0.42 + event.variant * 0.15);
    const baseX = Math.cos(angle) * radius * 0.62, baseY = Math.sin(angle) * radius * 0.62;
    context.moveTo(baseX, baseY); context.lineTo(baseX + Math.cos(angle + 0.72) * branch, baseY + Math.sin(angle + 0.72) * branch);
    if ((index + event.id) % 5 !== 0) { context.moveTo(baseX, baseY); context.lineTo(baseX + Math.cos(angle - 0.72) * branch, baseY + Math.sin(angle - 0.72) * branch) }
    if (event.variant > 0.55) {
      const innerX = Math.cos(angle) * radius * 0.34, innerY = Math.sin(angle) * radius * 0.34;
      const twig = branch * 0.48;
      context.moveTo(innerX, innerY); context.lineTo(innerX + Math.cos(angle + 0.82) * twig, innerY + Math.sin(angle + 0.82) * twig);
      context.moveTo(innerX, innerY); context.lineTo(innerX + Math.cos(angle - 0.82) * twig, innerY + Math.sin(angle - 0.82) * twig);
    }
  }
  context.stroke();
  context.beginPath(); context.arc(0, 0, 2.2 + event.variant * 1.8, 0, TAU); context.fill();
  spriteCache.set(key, sprite);
  return sprite;
}

function drawSnowflake(context: CanvasRenderingContext2D, x: number, y: number, event: VisualEvent, alpha: number, mirrored = false, original = false) {
  const sprite = snowflakeSprite(event, original);
  context.save();
  context.translate(x, y); context.scale(mirrored ? -1 : 1, 1); context.rotate(event.variant * Math.PI);
  context.globalAlpha = alpha; context.globalCompositeOperation = 'lighter';
  context.drawImage(sprite, -sprite.width / 2, -sprite.height / 2);
  context.restore();
}

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const soundInputRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<number | null>(null);
  const eventsRef = useRef<VisualEvent[]>(INITIAL_EVENTS);
  const speedRef = useRef({ outer: 0.13, inner: 0.08 });
  const scaleRef = useRef<ScaleName>('minorPentatonic');
  const soundPoolRef = useRef<string[]>(['default']);
  const runningRef = useRef(true);
  const angleRef = useRef({ outer: 0, inner: 0, corner: 0, star: 0 });
  const trianglePulseRef = useRef<{ start: number | null; next: number; sequence: number }>({ start: null, next: 0, sequence: 0 });
  const pointerRef = useRef<{ id: number; start: Point; eventId: number | null; moved: boolean } | null>(null);
  const hoverRef = useRef<number | null>(null);
  const nextIdRef = useRef(1);
  const collisionRef = useRef(new Map<number, Set<string>>());
  const ballsRef = useRef<FieldBall[]>(initialBalls());
  const ballContactsRef = useRef(new Set<string>());
  const audioRef = useRef<AudioState>({ context: null, buffers: new Map(), loads: new Map(), voices: new Map(), roomBus: null, chorusBus: null, shimmerBus: null, shimmerSources: new Set(), delayedSources: new Set(), delayOutputs: new Set() });
  const [events, setEvents] = useState(INITIAL_EVENTS);
  const [masterSpeed, setMasterSpeed] = useState(0.13);
  const [scaleName, setScaleName] = useState<ScaleName>('minorPentatonic');
  const [soundNames, setSoundNames] = useState(['c.ogg']);
  const [running, setRunning] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => { eventsRef.current = events }, [events]);
  useEffect(() => { speedRef.current = { outer: masterSpeed, inner: masterSpeed * 0.62 } }, [masterSpeed]);
  useEffect(() => { scaleRef.current = scaleName }, [scaleName]);
  useEffect(() => { runningRef.current = running }, [running]);
  useEffect(() => {
    const updateFullscreen = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', updateFullscreen);
    return () => document.removeEventListener('fullscreenchange', updateFullscreen);
  }, []);

  const changeMasterSpeed = useCallback((value: number) => {
    setMasterSpeed(value);
    speedRef.current = { outer: value, inner: value * 0.62 };
  }, []);

  const enterFullscreen = useCallback(async () => {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
  }, []);

  const loadSound = useCallback(async (sampleId: string) => {
    const state = audioRef.current;
    if (!state.context) state.context = new AudioContext();
    if (state.context.state === 'suspended') await state.context.resume();
    const loaded = state.buffers.get(sampleId);
    if (loaded) return loaded;
    if (sampleId !== 'default') return null;
    if (!state.loads.has(sampleId)) {
      const context = state.context;
      const loading = fetch('/c.ogg')
        .then((response) => { if (!response.ok) throw new Error('Unable to load c.ogg'); return response.arrayBuffer() })
        .then((data) => context.decodeAudioData(data))
        .then((buffer) => { state.buffers.set(sampleId, buffer); return buffer })
        .catch(() => { state.loads.delete(sampleId); return null });
      state.loads.set(sampleId, loading);
    }
    return state.loads.get(sampleId) ?? null;
  }, []);

  const loadLocalSounds = useCallback(async (files: FileList | null) => {
    const selected = [...(files ?? [])].slice(0, 5);
    if (!selected.length) return;
    const state = audioRef.current;
    if (!state.context) state.context = new AudioContext();
    if (state.context.state === 'suspended') await state.context.resume();
    const generation = Date.now().toString(36);
    const decoded = await Promise.all(selected.map(async (file, index) => {
      try {
        const buffer = await state.context!.decodeAudioData(await file.arrayBuffer());
        return { id: `local-${generation}-${index}`, name: file.name, buffer };
      } catch { return null }
    }));
    const valid = decoded.filter((item): item is { id: string; name: string; buffer: AudioBuffer } => item !== null);
    if (!valid.length) return;
    for (const item of valid) state.buffers.set(item.id, item.buffer);
    soundPoolRef.current = valid.map((item) => item.id);
    setSoundNames(valid.map((item) => item.name));
  }, []);

  const changeScale = useCallback((nextScale: ScaleName) => {
    scaleRef.current = nextScale;
    setScaleName(nextScale);
    setEvents((current) => current.map((event) => ({ ...event, midi: pitchForY(event.y, nextScale) })));
  }, []);

  const triggerSound = useCallback(async (event: VisualEvent) => {
    const buffer = await loadSound(event.sampleId);
    const state = audioRef.current, context = state.context;
    if (!buffer || !context) return;
    const source = context.createBufferSource(), envelope = context.createGain(), level = context.createGain(), panner = context.createStereoPanner();
    const now = context.currentTime, playbackRate = 2 ** ((event.midi - 60) / 12);
    const duration = Math.min(buffer.duration / playbackRate, 3.5);
    const spatial = spatialAudioFor(event);
    source.buffer = buffer; source.playbackRate.value = playbackRate;
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(1, now + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(0.04, duration));
    level.gain.setValueAtTime(0.24 * spatial.level, now);
    panner.pan.setValueAtTime(spatial.pan, now);
    const roomBus = ensureRoomBus(context, state), chorusBus = ensureChorusBus(context, state), shimmerBus = ensureShimmerBus(context, state);
    source.connect(envelope).connect(level).connect(panner);
    panner.connect(context.destination);
    panner.connect(roomBus.input);
    const chorusAmount = reflectionChorusAmount(event, angleRef.current.outer, angleRef.current.inner);
    const radialAmount = Math.max(0, Math.min(1, Math.hypot(event.x, event.y) / 0.57));
    setChorusShimmerSend(context, chorusBus, shimmerBus, radialAmount * 0.13);
    const chorusSend = context.createGain();
    chorusSend.gain.value = chorusAmount * 0.3;
    panner.connect(chorusSend).connect(chorusBus.input);
    const voice = { source, level, panner };
    const voices = state.voices.get(event.id) ?? new Set<ActiveVoice>();
    voices.add(voice); state.voices.set(event.id, voices);
    source.addEventListener('ended', () => {
      const active = state.voices.get(event.id);
      active?.delete(voice);
      if (active?.size === 0) state.voices.delete(event.id);
    }, { once: true });
    source.start(now); source.stop(now + duration + 0.02);
  }, [loadSound]);

  const triggerShimmer = useCallback(async (event: VisualEvent, amount: number) => {
    const buffer = await loadSound(event.sampleId);
    const state = audioRef.current, context = state.context;
    if (!buffer || !context) return;
    const bus = ensureShimmerBus(context, state);
    const envelope = context.createGain(), panner = context.createStereoPanner();
    const now = context.currentTime, baseRate = 2 ** ((event.midi - 60) / 12), spatial = spatialAudioFor(event);
    const wetness = Math.max(0, Math.min(1, amount));
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime((0.12 + wetness * 0.5) * spatial.level, now + 0.045);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + 4.8);
    panner.pan.setValueAtTime(spatial.pan, now);
    envelope.connect(panner).connect(bus.input);
    const rates = [baseRate * 2, baseRate * 3];
    rates.forEach((rate, index) => {
      const source = context.createBufferSource(), layer = context.createGain();
      source.buffer = buffer; source.playbackRate.value = rate;
      layer.gain.value = index === 0 ? 0.82 : 0.1 + wetness * 0.3;
      source.connect(layer).connect(envelope);
      state.shimmerSources.add(source);
      source.addEventListener('ended', () => state.shimmerSources.delete(source), { once: true });
      const duration = Math.min(buffer.duration / rate, 2.4);
      source.start(now + index * 0.075);
      source.stop(now + index * 0.075 + duration + 0.02);
    });
  }, [loadSound]);

  const triggerDelay = useCallback(async (event: VisualEvent) => {
    const buffer = await loadSound(event.sampleId);
    const state = audioRef.current, context = state.context;
    if (!buffer || !context) return;
    const roomBus = ensureRoomBus(context, state), chorusBus = ensureChorusBus(context, state), shimmerBus = ensureShimmerBus(context, state);
    const source = context.createBufferSource(), envelope = context.createGain(), level = context.createGain(), panner = context.createStereoPanner();
    const delay = context.createDelay(1.2), feedback = context.createGain(), feedbackTone = context.createBiquadFilter(), output = context.createGain(), dry = context.createGain(), echoPanner = context.createStereoPanner();
    const now = context.currentTime, playbackRate = 2 ** ((event.midi - 60) / 12), spatial = spatialAudioFor(event);
    const radialAmount = Math.max(0, Math.min(1, Math.hypot(event.x, event.y) / 0.57));
    const delayTime = 0.16 + radialAmount * 0.56;
    const duration = Math.min(buffer.duration / playbackRate, 3.5);
    source.buffer = buffer; source.playbackRate.value = playbackRate;
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(1, now + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(0.04, duration));
    level.gain.value = 0.24 * spatial.level;
    panner.pan.value = spatial.pan;
    delay.delayTime.value = delayTime;
    feedback.gain.setValueAtTime(0.3, now);
    feedback.gain.setTargetAtTime(0.0001, now + duration + delayTime * 3, Math.max(0.08, delayTime));
    feedbackTone.type = 'lowpass'; feedbackTone.frequency.value = 5200;
    dry.gain.value = 0.4;
    output.gain.value = 0.6;
    const echoTargetPan = event.x < 0 ? -0.95 : 0.95;
    echoPanner.pan.setValueAtTime(spatial.pan, now);
    echoPanner.pan.setValueAtTime(spatial.pan, now + delayTime);
    echoPanner.pan.linearRampToValueAtTime(echoTargetPan, now + delayTime * 2.2);
    source.connect(envelope).connect(level).connect(panner);
    panner.connect(dry);
    panner.connect(delay);
    dry.connect(context.destination);
    dry.connect(roomBus.input);
    delay.connect(echoPanner).connect(output);
    delay.connect(feedback).connect(feedbackTone).connect(delay);
    output.connect(context.destination);
    output.connect(roomBus.input);
    const chorusSend = context.createGain();
    chorusSend.gain.value = reflectionChorusAmount(event, angleRef.current.outer, angleRef.current.inner) * 0.3;
    setChorusShimmerSend(context, chorusBus, shimmerBus, radialAmount * 0.13);
    dry.connect(chorusSend);
    output.connect(chorusSend).connect(chorusBus.input);
    const delayShimmerSend = context.createGain();
    delayShimmerSend.gain.value = radialAmount * 0.18;
    output.connect(delayShimmerSend).connect(shimmerBus.input);
    state.delayedSources.add(source); state.delayOutputs.add(output);
    source.addEventListener('ended', () => state.delayedSources.delete(source), { once: true });
    source.start(now); source.stop(now + duration + 0.02);
    window.setTimeout(() => {
      if (state.delayOutputs.delete(output)) output.disconnect();
    }, (duration + delayTime * 7 + 1) * 1000);
  }, [loadSound]);

  const silenceAudio = useCallback(() => {
    for (const voices of audioRef.current.voices.values()) for (const voice of voices) { try { voice.source.stop() } catch {} }
    audioRef.current.voices.clear();
    for (const source of audioRef.current.shimmerSources) { try { source.stop() } catch {} }
    audioRef.current.shimmerSources.clear();
    for (const source of audioRef.current.delayedSources) { try { source.stop() } catch {} }
    audioRef.current.delayedSources.clear();
    for (const output of audioRef.current.delayOutputs) output.disconnect();
    audioRef.current.delayOutputs.clear();
    audioRef.current.roomBus?.output.disconnect();
    audioRef.current.roomBus = null;
    if (audioRef.current.chorusBus) {
      for (const modulator of audioRef.current.chorusBus.modulators) { try { modulator.stop() } catch {} }
      audioRef.current.chorusBus.output.disconnect();
      audioRef.current.chorusBus = null;
    }
    audioRef.current.shimmerBus?.output.disconnect();
    audioRef.current.shimmerBus = null;
  }, []);

  useEffect(() => () => {
    silenceAudio();
    void audioRef.current.context?.close();
  }, [silenceAudio]);

  const canvasPoint = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect(), scale = Math.min(rect.width, rect.height) * 0.82;
    return { x: (clientX - rect.left - rect.width / 2) / scale, y: (clientY - rect.top - rect.height / 2) / scale };
  }, []);

  const hitEvent = useCallback((point: Point) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect(), hitRadius = 26 / (Math.min(rect.width, rect.height) * 0.82);
    for (let index = eventsRef.current.length - 1; index >= 0; index -= 1) {
      const event = eventsRef.current[index];
      if (Math.hypot(event.x - point.x, event.y - point.y) < hitRadius) return event.id;
    }
    return null;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current, context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    let previous = performance.now();
    let lastRendered = 0;
    let driftSync = 0;
    const render = (now: number) => {
      if (now - lastRendered < TARGET_FRAME_MS) { frameRef.current = requestAnimationFrame(render); return }
      lastRendered = now;
      const rect = canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 1.25);
      const width = Math.max(1, Math.round(rect.width * dpr)), height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
      context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, rect.width, rect.height);
      const cx = rect.width / 2, cy = rect.height / 2, scale = Math.min(rect.width, rect.height) * 0.82;
      const delta = Math.min((now - previous) / 1000, 0.05); previous = now;
      if (runningRef.current) {
        angleRef.current.outer += delta * speedRef.current.outer;
        angleRef.current.inner -= delta * speedRef.current.inner;
        angleRef.current.corner += delta * speedRef.current.outer * 0.35;
        angleRef.current.star += delta * speedRef.current.outer * 0.46;
      }

      const pulse = trianglePulseRef.current;
      if (pulse.next === 0) pulse.next = now + 18000;
      if (pulse.start === null && now >= pulse.next) pulse.start = now;
      let triangleBend = 0;
      if (pulse.start !== null) {
        const progress = (now - pulse.start) / 6000;
        if (progress >= 1) {
          pulse.start = null; pulse.sequence += 1;
          pulse.next = now + 15000 + ((pulse.sequence * 7919) % 15000);
        } else {
          triangleBend = -Math.sin(progress * TAU) * 0.052;
        }
      }
      const triangleRadius = scale * 0.344;
      const starRadius = triangleRadius * 0.28;
      const triangleMirror = triangleMirrorGeometry(cx, cy, triangleRadius, angleRef.current.inner, triangleBend, angleRef.current.corner);
      const triangle = triangleMirror.path;
      const outerRadius = scale * 0.57;
      const outerMirror = outerMirrorGeometry(cx, cy, outerRadius, angleRef.current.outer);
      const outerWallEdges = outerMirror.joints.map((joint, index) => linePath(joint.shoulderAfter, outerMirror.joints[(index + 1) % outerMirror.joints.length].shoulderBefore));
      const outerSpokes = Array.from({ length: 14 }, (_, index) => {
        const axis = angleRef.current.outer + (index * Math.PI) / 7;
        return linePath(
          { x: cx + Math.cos(axis) * triangleRadius * 0.94, y: cy + Math.sin(axis) * triangleRadius * 0.94 },
          { x: cx + Math.cos(axis) * outerRadius * 1.1, y: cy + Math.sin(axis) * outerRadius * 1.1 },
        );
      });
      const triangleSpokes = Array.from({ length: 3 }, (_, index) => {
        const axis = angleRef.current.inner - Math.PI / 2 + (index * TAU) / 3;
        return linePath({ x: cx, y: cy }, { x: cx + Math.cos(axis) * triangleRadius, y: cy + Math.sin(axis) * triangleRadius });
      });
      const starSegments = Array.from({ length: 3 }, (_, index) => {
        const axis = angleRef.current.star - Math.PI / 2 + (index * TAU) / 3;
        return { from: { x: 0, y: 0 }, to: { x: Math.cos(axis) * starRadius / scale, y: Math.sin(axis) * starRadius / scale } };
      });
      const starArms = starSegments.map((segment) => linePath(
        { x: cx + segment.from.x * scale, y: cy + segment.from.y * scale },
        { x: cx + segment.to.x * scale, y: cy + segment.to.y * scale },
      ));
      const mirrorSurfaces: MirrorSurface[] = [
        ...outerWallEdges.map((path, index) => ({ id: `outer-wall-${index}`, path })),
        ...outerMirror.joints.map((joint, index) => ({ id: `outer-joint-${index}`, path: joint.path })),
        ...outerSpokes.map((path, index) => ({ id: `outer-spoke-${index}`, path, clip: outerMirror.path })),
        { id: 'triangle-wall', path: triangle },
        ...triangleMirror.corners.map((corner, index) => ({ id: `triangle-corner-${index}`, path: corner.path })),
        ...triangleSpokes.map((path, index) => ({ id: `triangle-spoke-${index}`, path })),
        ...starArms.map((path, index) => ({ id: `star-arm-${index}`, path })),
      ];
      const triangleBoundary = triangleMirror.vertices.map((point) => ({ x: (point.x - cx) / scale, y: (point.y - cy) / scale }));
      const outerBoundary = outerMirror.boundary.map((point) => ({ x: (point.x - cx) / scale, y: (point.y - cy) / scale }));
      const cornerSurfaces = triangleMirror.corners.map((corner, index) => {
        const points = [corner.shoulderBefore, corner.tip, corner.shoulderAfter].map((point) => ({ x: (point.x - cx) / scale, y: (point.y - cy) / scale }));
        const centre = { x: (points[0].x + points[1].x + points[2].x) / 3, y: (points[0].y + points[1].y + points[2].y) / 3 };
        const segments = points.map((from, pointIndex) => ({ from, to: points[(pointIndex + 1) % points.length] }));
        const mainSpin = -speedRef.current.inner, localSpin = speedRef.current.outer * 0.35 * (index % 2 === 0 ? 1 : -1);
        return {
          path: corner.path,
          points,
          segments,
          velocity: (point: Point) => ({
            x: -mainSpin * point.y - localSpin * (point.y - centre.y),
            y: mainSpin * point.x + localSpin * (point.x - centre.x),
          }),
        };
      });
      const insidePath = (path: Path2D, point: Point) => context.isPointInPath(path, cx + point.x * scale, cy + point.y * scale);

      if (runningRef.current) {
        const draggedId = pointerRef.current?.eventId ?? null;
        eventsRef.current = eventsRef.current.map((event) => {
          if (event.id === draggedId) return event;
          const distance = Math.hypot(event.x, event.y);
          if (distance < 0.0001) return event;
          const insideTriangle = context.isPointInPath(triangle, cx + event.x * scale, cy + event.y * scale);
          const orbit = rotate(event, delta * (insideTriangle ? 0.008 : -0.006) * event.orbit);
          const outward = CENTRIFUGAL_DRIFT * event.pull * (0.25 + Math.min(distance, 1.5) * 1.25) * delta;
          return { ...event, x: orbit.x + (orbit.x / distance) * outward, y: orbit.y + (orbit.y / distance) * outward };
        });
        driftSync += delta;
        if (driftSync > 0.25) { driftSync = 0; setEvents(eventsRef.current) }
      }

      const ballNudgedIds = new Set<number>();
      if (runningRef.current) {
        const draggedId = pointerRef.current?.eventId ?? null;
        const nextBallContacts = new Set<string>();
        for (const ball of ballsRef.current) {
          ball.boost = 1 + (ball.boost - 1) * Math.exp(-delta / 0.7);
          if (ball.zone === 'outer') {
            const currentSpeed = Math.hypot(ball.vx, ball.vy);
            const minimumSpeed = ball.id === 'outer-a' ? 0.088 : 0.086;
            const wallEdgeSpeed = Math.abs(speedRef.current.outer) * 0.57;
            const safetyMargin = ball.id === 'outer-a' ? 1.16 : 1.2;
            const targetSpeed = Math.max(minimumSpeed, wallEdgeSpeed * safetyMargin);
            if (currentSpeed > 0.0001) {
              ball.vx *= targetSpeed / currentSpeed;
              ball.vy *= targetSpeed / currentSpeed;
            }
          }
          const clearance = ball.radius / scale + 0.0015;
          const outerHardClearance = (ball.radius + 5.5) / scale + 0.0015;
          const insideTriangle = (point: Point) => insidePath(triangle, point);
          const outsideTriangle = (point: Point) => !insidePath(triangle, point);
          const insideOuter = (point: Point) => insidePath(outerMirror.path, point);
          if (ball.zone === 'inner' && !insideTriangle(ball)) bounceBall(ball, ball, triangleBoundary, insideTriangle, clearance, -speedRef.current.inner);
          if (ball.zone === 'inner') {
            for (const surface of cornerSurfaces) {
              if (insidePath(surface.path, ball)) ejectBallFromPolygon(ball, surface.points, clearance, surface.velocity, insideTriangle);
            }
          }
          if (ball.zone === 'outer') {
            if (!insideOuter(ball)) bounceBall(ball, ball, outerBoundary, insideOuter, outerHardClearance, speedRef.current.outer, { strongOuter: true });
            if (insideTriangle(ball)) bounceBall(ball, ball, triangleBoundary, outsideTriangle, clearance, -speedRef.current.inner);
          }
          const substep = delta / 4;
          for (let step = 0; step < 4; step += 1) {
            const proposed = { x: ball.x + ball.vx * substep * ball.boost, y: ball.y + ball.vy * substep * ball.boost };
            if (ball.zone === 'inner') {
              if (!insideTriangle(proposed)) bounceBall(ball, proposed, triangleBoundary, insideTriangle, clearance, -speedRef.current.inner);
              else {
                let bounced = bounceBallOffSegments(ball, proposed, starSegments, clearance, (point) => ({ x: -speedRef.current.outer * 0.46 * point.y, y: speedRef.current.outer * 0.46 * point.x }));
                if (!bounced) {
                  for (const surface of cornerSurfaces) {
                    if (insidePath(surface.path, proposed)) {
                      ball.x = proposed.x; ball.y = proposed.y;
                      ejectBallFromPolygon(ball, surface.points, clearance, surface.velocity, insideTriangle);
                      bounced = true; break;
                    }
                    if (bounceBallOffSegments(ball, proposed, surface.segments, clearance, surface.velocity)) { bounced = true; break }
                  }
                }
                if (!bounced) { ball.x = proposed.x; ball.y = proposed.y }
              }
            } else {
              const outerHit = closestBoundaryHit(proposed, outerBoundary);
              const outerDistance = Math.hypot(proposed.x - outerHit.point.x, proposed.y - outerHit.point.y);
              if (!insideOuter(proposed)) {
                bounceBall(ball, proposed, outerBoundary, insideOuter, outerHardClearance, speedRef.current.outer, { strongOuter: true });
              } else if (outerDistance <= outerHardClearance && bounceBall(ball, proposed, outerBoundary, insideOuter, outerHardClearance, speedRef.current.outer, { strongOuter: true, onlyIfApproaching: true })) {
                // The black inner edge, not the glow, is the ball's hard contact surface.
              } else if (insideTriangle(proposed)) {
                bounceBall(ball, proposed, triangleBoundary, outsideTriangle, clearance, -speedRef.current.inner);
              } else {
                ball.x = proposed.x; ball.y = proposed.y;
              }
            }
          }
          for (const event of eventsRef.current) {
            const contactId = `${ball.id}-${event.id}`;
            const collisionDistance = (ball.radius + 10 + event.size * 8) / scale;
            const dx = event.x - ball.x, dy = event.y - ball.y, distance = Math.hypot(dx, dy);
            if (distance > collisionDistance) continue;
            nextBallContacts.add(contactId);
            if (ballContactsRef.current.has(contactId) || event.id === draggedId) continue;
            const normalLength = distance || Math.hypot(ball.vx, ball.vy) || 1;
            const nx = distance ? dx / normalLength : ball.vx / normalLength;
            const ny = distance ? dy / normalLength : ball.vy / normalLength;
            eventsRef.current = eventsRef.current.map((candidate) => candidate.id === event.id ? { ...candidate, x: candidate.x + nx * 0.004, y: candidate.y + ny * 0.004 } : candidate);
            ballNudgedIds.add(event.id);
          }
        }
        ballContactsRef.current = nextBallContacts;
        if (ballNudgedIds.size) setEvents(eventsRef.current);
      }

      const retiredIds = new Set<number>();
      const survivingEvents = eventsRef.current.filter((event) => {
        const visibleRadius = 10 + event.size * 8;
        const overlapsEnclosure = Math.hypot(event.x, event.y) * scale <= outerRadius + visibleRadius;
        if (!overlapsEnclosure) retiredIds.add(event.id);
        return overlapsEnclosure;
      });
      if (retiredIds.size) {
        eventsRef.current = survivingEvents;
        setEvents(survivingEvents);
        for (const id of retiredIds) {
          collisionRef.current.delete(id);
          const voices = audioRef.current.voices.get(id);
          if (voices) for (const voice of voices) { try { voice.source.stop() } catch {} }
          audioRef.current.voices.delete(id);
        }
        ballContactsRef.current = new Set([...ballContactsRef.current].filter((contact) => ![...retiredIds].some((id) => contact.endsWith(`-${id}`))));
      }

      const audioState = audioRef.current;
      if (audioState.context) {
        const audioNow = audioState.context.currentTime;
        for (const event of eventsRef.current) {
          const voices = audioState.voices.get(event.id);
          if (!voices) continue;
          const spatial = spatialAudioFor(event);
          for (const voice of voices) {
            voice.level.gain.setTargetAtTime(0.24 * spatial.level, audioNow, 0.035);
            voice.panner.pan.setTargetAtTime(spatial.pan, audioNow, 0.035);
          }
        }
      }

      const liveEventIds = new Set(eventsRef.current.map((event) => event.id));
      for (const id of collisionRef.current.keys()) if (!liveEventIds.has(id)) collisionRef.current.delete(id);
      for (const event of eventsRef.current) {
        const touching = new Set<string>();
        const point = { x: cx + event.x * scale, y: cy + event.y * scale };
        context.save(); context.lineWidth = (10 + event.size * 8) * 2;
        for (const surface of mirrorSurfaces) {
          if ((!surface.clip || context.isPointInPath(surface.clip, point.x, point.y)) && context.isPointInStroke(surface.path, point.x, point.y)) touching.add(surface.id);
        }
        context.restore();
        const previous = collisionRef.current.get(event.id);
        const newlyTouched = previous ? [...touching].filter((surface) => !previous.has(surface)) : [];
        if (!ballNudgedIds.has(event.id) && newlyTouched.length) {
          if (Math.random() < 0.05) void triggerDelay(event);
          else void triggerSound(event);
          if (newlyTouched.some((surface) => surface.startsWith('outer-wall-'))) {
            const radialProgress = (Math.hypot(event.x, event.y) - triangleRadius / scale) / ((outerRadius - triangleRadius) / scale);
            void triggerShimmer(event, radialProgress);
          }
        }
        collisionRef.current.set(event.id, touching);
      }
      const glow = context.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rect.width, rect.height) * 0.68);
      glow.addColorStop(0, 'rgba(20, 29, 43, 0.92)'); glow.addColorStop(0.42, 'rgba(8, 12, 22, 0.96)'); glow.addColorStop(1, '#030509');
      context.fillStyle = glow; context.fillRect(0, 0, rect.width, rect.height);
      context.save(); context.translate(cx, cy); context.strokeStyle = 'rgba(143, 222, 255, 0.028)'; context.lineWidth = 1;
      [0.28, 0.54, 0.82].forEach((radius) => { context.beginPath(); context.arc(0, 0, scale * radius, 0, TAU); context.stroke() }); context.restore();

      context.save();
      const outsideTriangle = new Path2D();
      outsideTriangle.rect(0, 0, rect.width, rect.height);
      outsideTriangle.addPath(triangle);
      context.clip(outerMirror.path);
      context.clip(outsideTriangle, 'evenodd');
      for (const event of eventsRef.current) {
        for (const copy of mirrorCopies(event, 7, angleRef.current.outer)) {
          if (copy.original) continue;
          const brightness = copyBrightness(event, copy.point);
          drawSnowflake(context, cx + copy.point.x * scale, cy + copy.point.y * scale, event, 0.82 * brightness, copy.reflected, copy.original);
        }
      }
      context.restore();

      for (const joint of outerMirror.joints) {
        context.save();
        context.clip(joint.path);
        for (const event of eventsRef.current) {
          for (const copy of mirrorCopies(event, 7, angleRef.current.outer)) {
            const point = { x: cx + copy.point.x * scale, y: cy + copy.point.y * scale };
            if (Math.hypot(point.x - joint.tip.x, point.y - joint.tip.y) > outerRadius * (joint.isLong ? 0.38 : 0.2)) continue;
            const firstFold = reflectAcrossLine(point, joint.shoulderBefore, joint.tip);
            const secondFold = reflectAcrossLine(point, joint.tip, joint.shoulderAfter);
            const firstBrightness = copyBrightness(event, { x: (firstFold.x - cx) / scale, y: (firstFold.y - cy) / scale });
            const secondBrightness = copyBrightness(event, { x: (secondFold.x - cx) / scale, y: (secondFold.y - cy) / scale });
            drawSnowflake(context, firstFold.x, firstFold.y, event, 0.64 * firstBrightness, !copy.reflected);
            drawSnowflake(context, secondFold.x, secondFold.y, event, 0.58 * secondBrightness, copy.reflected);
          }
        }
        context.restore();
      }

      context.save();
      context.clip(triangle);
      for (const event of eventsRef.current) {
        for (const copy of mirrorCopies(event, 3, angleRef.current.inner, true)) {
          drawSnowflake(context, cx + copy.point.x * scale, cy + copy.point.y * scale, event, 0.76 * copyBrightness(event, copy.point), copy.reflected);
        }
      }
      context.restore();

      for (const corner of triangleMirror.corners) {
        context.save();
        context.clip(corner.path);
        for (const event of eventsRef.current) {
          for (const copy of mirrorCopies(event, 3, angleRef.current.inner, true)) {
            const point = { x: cx + copy.point.x * scale, y: cy + copy.point.y * scale };
            if (Math.hypot(point.x - corner.tip.x, point.y - corner.tip.y) > triangleRadius * 0.34) continue;
            const firstFold = reflectAcrossLine(point, corner.shoulderBefore, corner.tip);
            const secondFold = reflectAcrossLine(point, corner.tip, corner.shoulderAfter);
            const firstBrightness = copyBrightness(event, { x: (firstFold.x - cx) / scale, y: (firstFold.y - cy) / scale });
            const secondBrightness = copyBrightness(event, { x: (secondFold.x - cx) / scale, y: (secondFold.y - cy) / scale });
            drawSnowflake(context, firstFold.x, firstFold.y, event, 0.7 * firstBrightness, !copy.reflected);
            drawSnowflake(context, secondFold.x, secondFold.y, event, 0.64 * secondBrightness, copy.reflected);
          }
        }
        context.restore();
      }

      const starClip = new Path2D();
      starClip.arc(cx, cy, starRadius, 0, TAU);
      context.save();
      context.clip(triangle);
      context.clip(starClip);
      for (const event of eventsRef.current) {
        for (const copy of mirrorCopies(event, 3, angleRef.current.star)) {
          drawSnowflake(context, cx + copy.point.x * scale, cy + copy.point.y * scale, event, 0.72 * copyBrightness(event, copy.point), copy.reflected);
        }
      }
      context.restore();

      context.save();
      context.clip(outerMirror.path);
      for (const event of eventsRef.current) {
        const pulseBrightness = 0.82 + Math.sin(now * 0.00072 + event.id * 1.37) * 0.16;
        drawSnowflake(context, cx + event.x * scale, cy + event.y * scale, event, pulseBrightness, false, true);
      }
      context.restore();

      for (const ball of ballsRef.current) {
        context.save();
        context.clip(ball.zone === 'inner' ? triangle : outerMirror.path);
        if (ball.zone === 'outer') context.clip(outsideTriangle, 'evenodd');
        const x = cx + ball.x * scale, y = cy + ball.y * scale;
        context.beginPath(); context.arc(x, y, ball.radius, 0, TAU);
        context.shadowColor = `hsl(${ball.hue} 95% 64%)`; context.shadowBlur = 14;
        context.fillStyle = `hsl(${ball.hue} 90% 72%)`; context.fill();
        context.beginPath(); context.arc(x - ball.radius * 0.28, y - ball.radius * 0.32, ball.radius * 0.28, 0, TAU);
        context.fillStyle = 'rgba(255,255,255,0.72)'; context.fill();
        context.restore();
      }

      context.save();
      context.clip(outerMirror.path);
      context.clip(outsideTriangle, 'evenodd');
      context.translate(cx, cy);
      for (let index = 0; index < 14; index += 1) {
        const axis = angleRef.current.outer + (index * Math.PI) / 7;
        const from = triangleRadius * 0.94;
        context.beginPath(); context.moveTo(Math.cos(axis) * from, Math.sin(axis) * from); context.lineTo(Math.cos(axis) * outerRadius * 1.1, Math.sin(axis) * outerRadius * 1.1);
        context.strokeStyle = 'rgba(1, 3, 8, 0.82)'; context.lineWidth = 5; context.stroke();
        context.strokeStyle = 'rgba(113, 225, 255, 0.13)'; context.lineWidth = 0.7; context.stroke();
      }
      context.restore();

      context.save();
      context.shadowColor = 'rgba(87, 213, 255, 0.5)'; context.shadowBlur = 14;
      context.strokeStyle = 'rgba(1, 3, 8, 0.94)'; context.lineWidth = 11; context.stroke(outerMirror.path);
      context.strokeStyle = 'rgba(128, 225, 255, 0.42)'; context.lineWidth = 1; context.stroke(outerMirror.path);
      for (const joint of outerMirror.joints) {
        context.fillStyle = 'rgba(111, 205, 255, 0.045)'; context.fill(joint.path);
        context.strokeStyle = 'rgba(1, 3, 8, 0.92)'; context.lineWidth = 7; context.stroke(joint.path);
        context.strokeStyle = 'rgba(187, 236, 255, 0.46)'; context.lineWidth = 0.9; context.stroke(joint.path);
      }
      context.restore();

      context.save();
      context.clip(triangle);
      context.translate(cx, cy);
      for (let index = 0; index < 3; index += 1) {
        const axis = angleRef.current.inner - Math.PI / 2 + (index * TAU) / 3;
        context.beginPath(); context.moveTo(0, 0); context.lineTo(Math.cos(axis) * triangleRadius, Math.sin(axis) * triangleRadius);
        context.strokeStyle = 'rgba(2, 4, 10, 0.7)'; context.lineWidth = 4; context.stroke();
        context.strokeStyle = 'rgba(196, 169, 255, 0.16)'; context.lineWidth = 0.7; context.stroke();
      }
      context.restore();

      context.save();
      context.shadowColor = 'rgba(151, 111, 255, 0.65)'; context.shadowBlur = 14;
      context.strokeStyle = 'rgba(2, 4, 10, 0.92)'; context.lineWidth = 10; context.stroke(triangle);
      context.strokeStyle = 'rgba(173, 221, 255, 0.38)'; context.lineWidth = 1; context.stroke(triangle);
      for (const corner of triangleMirror.corners) {
        context.fillStyle = 'rgba(184, 147, 255, 0.055)'; context.fill(corner.path);
        context.strokeStyle = 'rgba(2, 4, 10, 0.94)'; context.lineWidth = 7; context.stroke(corner.path);
        context.strokeStyle = 'rgba(214, 191, 255, 0.5)'; context.lineWidth = 0.9; context.stroke(corner.path);
      }
      context.restore();

      context.save();
      context.clip(triangle);
      context.shadowColor = 'rgba(132, 106, 255, 0.72)'; context.shadowBlur = 12;
      for (let index = 0; index < 3; index += 1) {
        const axis = angleRef.current.star - Math.PI / 2 + (index * TAU) / 3;
        context.beginPath(); context.moveTo(cx, cy); context.lineTo(cx + Math.cos(axis) * starRadius, cy + Math.sin(axis) * starRadius);
        context.strokeStyle = 'rgba(2, 4, 10, 0.96)'; context.lineWidth = 8; context.lineCap = 'round'; context.stroke();
        context.strokeStyle = 'rgba(206, 188, 255, 0.58)'; context.lineWidth = 1; context.stroke();
      }
      context.beginPath(); context.arc(cx, cy, 4.5, 0, TAU);
      context.fillStyle = 'rgba(4, 7, 14, 0.96)'; context.fill();
      context.strokeStyle = 'rgba(205, 232, 255, 0.62)'; context.lineWidth = 0.9; context.stroke();
      context.restore();

      const activeId = pointerRef.current?.eventId ?? hoverRef.current;
      if (activeId !== null) {
        const selected = eventsRef.current.find((event) => event.id === activeId);
        if (selected) {
          if (context.isPointInPath(outerMirror.path, cx + selected.x * scale, cy + selected.y * scale)) {
            drawSnowflake(context, cx + selected.x * scale, cy + selected.y * scale, selected, 0.9, false, true);
          }
          context.beginPath(); context.arc(cx + selected.x * scale, cy + selected.y * scale, 25, 0, TAU);
          context.strokeStyle = 'rgba(232, 250, 255, 0.58)'; context.setLineDash([2, 5]); context.lineWidth = 1; context.stroke(); context.setLineDash([]);
        }
      }
      frameRef.current = requestAnimationFrame(render);
    };
    frameRef.current = requestAnimationFrame(render);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current) };
  }, [triggerDelay, triggerShimmer, triggerSound]);

  return (
    <main className="relative h-dvh min-h-[480px] w-full overflow-hidden bg-[#030509] text-[#eafaff]">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none cursor-crosshair" style={{ filter: 'blur(0.55px) saturate(1.04) brightness(1.01)' }} aria-label="Interactive kaleidoscopic field. Click to place an event, or drag an existing original event."
        onPointerDown={(e) => { const point = canvasPoint(e.clientX, e.clientY); pointerRef.current = { id: e.pointerId, start: point, eventId: hitEvent(point), moved: false }; e.currentTarget.setPointerCapture(e.pointerId) }}
        onPointerMove={(e) => {
          const point = canvasPoint(e.clientX, e.clientY), pointer = pointerRef.current;
          if (!pointer || pointer.id !== e.pointerId) { hoverRef.current = hitEvent(point); e.currentTarget.style.cursor = hoverRef.current ? 'grab' : 'crosshair'; return }
          if (Math.hypot(point.x - pointer.start.x, point.y - pointer.start.y) > 0.008) pointer.moved = true;
          if (pointer.eventId !== null) { e.currentTarget.style.cursor = 'grabbing'; setEvents((current) => current.map((event) => event.id === pointer.eventId ? { ...event, x: point.x, y: point.y } : event)) }
        }}
        onPointerUp={(e) => {
          const point = canvasPoint(e.clientX, e.clientY), pointer = pointerRef.current;
          if (pointer && pointer.id === e.pointerId && pointer.eventId === null && !pointer.moved) {
            const id = nextIdRef.current++, hue = PALETTE[(id - 1) % PALETTE.length];
            const pullBase = 0.78 + ((id * 29) % 45) / 100;
            const soundPool = soundPoolRef.current;
            const sampleId = soundPool[Math.floor(Math.random() * soundPool.length)] ?? 'default';
            const event: VisualEvent = { id, x: point.x, y: point.y, hue, size: 0.72 + ((id * 17) % 38) / 100, variant: ((id * 37) % 100) / 100, pull: pullBase * (0.95 + ((id * 43) % 101) / 1000), orbit: 0.95 + ((id * 31) % 101) / 1000, midi: pitchForY(point.y, scaleRef.current), sampleId };
            collisionRef.current.delete(id);
            setEvents((current) => [...current, event]);
            void triggerSound(event);
          }
          pointerRef.current = null; e.currentTarget.style.cursor = hitEvent(point) ? 'grab' : 'crosshair';
        }}
        onPointerCancel={() => { pointerRef.current = null }}
      />
      {!isFullscreen && <header className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 p-4 sm:p-6">
        <div>
          <div className="flex items-center gap-2.5"><span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_14px_#67e8f9]" /><h1 className="text-[11px] font-semibold tracking-[0.28em] text-white/90">SEPTA / TRIA</h1></div>
          <p className="mt-2 max-w-[270px] text-[10px] leading-relaxed tracking-[0.11em] text-white/36 uppercase">Click to seed · drag an original to reshape</p>
        </div>
        <div className="hidden items-center gap-2 text-[10px] tracking-[0.16em] text-white/38 uppercase sm:flex"><span className="rounded-full border border-cyan-200/12 bg-cyan-100/5 px-3 py-1.5">07 outer</span><span className="rounded-full border border-violet-200/12 bg-violet-100/5 px-3 py-1.5">03 inner</span></div>
      </header>}
      {!isFullscreen && <section className="absolute right-3 bottom-3 flex w-[min(320px,calc(100vw-1.5rem))] flex-col gap-3 rounded-2xl border border-white/10 bg-[#070b12]/78 p-3 shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur-xl sm:right-6 sm:bottom-6 sm:p-4" aria-label="Kaleidoscope controls">
        <SpeedControl label="Motion" value={masterSpeed} onChange={changeMasterSpeed} accent="cyan" />
        <div className="h-px w-full bg-white/10" />
        <label className="flex items-center gap-2">
          <span className="text-[10px] font-medium tracking-[0.16em] text-white/48 uppercase">Scale</span>
          <NativeSelect size="sm" value={scaleName} onChange={(event) => changeScale(event.target.value as ScaleName)} className="w-[150px] [&_select]:border-white/12 [&_select]:bg-white/[0.04] [&_select]:text-[11px] [&_select]:text-white/72">
            {Object.entries(SCALES).map(([name, scale]) => <NativeSelectOption key={name} value={name}>{scale.label}</NativeSelectOption>)}
          </NativeSelect>
        </label>
        <input ref={soundInputRef} type="file" accept="audio/*" multiple className="hidden" onChange={(event) => { void loadLocalSounds(event.currentTarget.files); event.currentTarget.value = '' }} />
        <Button variant="outline" size="sm" className="border-white/12 bg-white/[0.04] text-white/68 hover:bg-white/10 hover:text-white" onClick={() => soundInputRef.current?.click()} title={soundNames.join('\n')} aria-label={`Load up to five sounds. ${soundNames.length} currently loaded`}>
          <Upload data-icon="inline-start" />Sounds {soundNames.length}/5
        </Button>
        <div className="flex items-center gap-2 sm:ml-auto">
          <Button variant="outline" size="sm" className="flex-1 border-white/12 bg-white/[0.04] text-white/78 hover:bg-white/10 hover:text-white sm:flex-none" onClick={() => setRunning((value) => !value)} aria-label={running ? 'Pause rotation' : 'Run rotation'}>
            {running ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}{running ? 'Pause' : 'Run'}
          </Button>
          <Button variant="ghost" size="sm" className="flex-1 text-white/46 hover:bg-white/8 hover:text-white/80 sm:flex-none" onClick={() => { setEvents([]); collisionRef.current.clear(); ballContactsRef.current.clear(); ballsRef.current = initialBalls(); silenceAudio(); angleRef.current = { outer: 0, inner: 0, corner: 0, star: 0 } }} aria-label="Clear all events and reset geometry">
            <Trash2 data-icon="inline-start" />Clear
          </Button>
          <Button variant="ghost" size="icon-sm" className="text-white/48 hover:bg-white/8 hover:text-white/90" onClick={() => { void enterFullscreen() }} aria-label="Enter fullscreen presentation mode" title="Fullscreen · Escape to exit">
            <Maximize2 />
          </Button>
        </div>
      </section>}
    </main>
  );
}

function SpeedControl({ label, value, onChange, accent }: { label: string; value: number; onChange: (value: number) => void; accent: 'cyan' | 'violet' }) {
  const color = accent === 'cyan' ? 'text-cyan-200' : 'text-violet-200';
  return (
    <label className="grid min-w-0 flex-1 grid-cols-[68px_1fr_42px] items-center gap-3">
      <span className="text-[10px] font-medium tracking-[0.16em] text-white/48 uppercase">{label}</span>
      <Slider min={0} max={0.4} step={0.01} value={[value]} onValueChange={(next) => { const scalar = Array.isArray(next) ? next[0] : next; onChange(scalar ?? value) }} aria-label={`${label} rotation speed`} className="[&_[data-slot=slider-range]]:bg-white/65 [&_[data-slot=slider-track]]:bg-white/10 [&_[data-slot=slider-thumb]]:border-white/60 [&_[data-slot=slider-thumb]]:bg-[#dffaff] [&_[data-slot=slider-thumb]]:shadow-[0_0_10px_rgba(133,231,255,0.55)]" />
      <span className={`text-right font-mono text-[10px] tabular-nums ${color}`}>{value.toFixed(2)}</span>
    </label>
  );
}
