import { isLikelyRelevant } from "../src/lib/relevance";

const cases = [
  {
    name: "UniAD should remain visible",
    direction: "e2e",
    label: "端到端自动驾驶",
    query: "end-to-end autonomous driving planning perception UniAD",
    title: "Planning-Oriented Autonomous Driving with UniAD",
    abstract: "A planning-oriented autonomous driving system evaluated on nuScenes.",
    expected: true,
  },
  {
    name: "vehicle MPC should remain visible",
    direction: "control",
    label: "车辆控制",
    query: "vehicle control path tracking model predictive control",
    title: "Robust Model Predictive Control for Autonomous Vehicle Path Tracking",
    abstract: "We study steering and lateral control for an autonomous vehicle.",
    expected: true,
  },
  {
    name: "medical imaging should be hidden",
    direction: "perception",
    label: "BEV感知",
    query: "BEV perception 3D detection autonomous driving camera",
    title: "A Transformer for Medical Image Segmentation",
    abstract: "We segment tumors in clinical magnetic resonance images.",
    expected: false,
  },
  {
    name: "quantum circuit should be hidden",
    direction: "e2e",
    label: "端到端自动驾驶",
    query: "end-to-end autonomous driving planning perception UniAD",
    title: "Universal Fault-Tolerant Quantum Circuit Simulation",
    abstract: "A symbolic method for quantum circuit simulation.",
    expected: false,
  },
  {
    name: "hallucination control should remain visible",
    direction: "custom-hallucination",
    label: "自动驾驶幻觉控制",
    query: "autonomous driving hallucination control safety uncertainty",
    title: "Detecting Hallucinations in Vision-Language Models for Autonomous Driving",
    abstract: "We evaluate uncertainty and safety failures in an autonomous driving model.",
    expected: true,
  },
] as const;

let failures = 0;
for (const testCase of cases) {
  const actual = isLikelyRelevant(testCase, testCase.direction, testCase.label, testCase.query);
  if (actual !== testCase.expected) {
    failures += 1;
    console.error(`✗ ${testCase.name}: expected ${testCase.expected}, got ${actual}`);
  } else {
    console.log(`✓ ${testCase.name}`);
  }
}

if (failures > 0) {
  console.error(`${failures} relevance regression(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`${cases.length} relevance checks passed`);
}
