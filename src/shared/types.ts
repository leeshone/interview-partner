// Types and constants shared by the server and the client.

export type InterviewType = 'behavioral' | 'coding' | 'system-design' | 'role-specific';
export type Difficulty = 'junior' | 'mid' | 'senior' | 'staff';
export type PersonaId = 'friendly-recruiter' | 'tough-manager' | 'skeptical-engineer' | 'neutral-faang';
export type FeedbackMode = 'both' | 'end-only' | 'every-answer';

export interface SessionConfig {
  type: InterviewType;
  difficulty: Difficulty;
  persona: PersonaId;
  lengthMin: 15 | 30 | 45 | 60;
  answerTimerSec: 0 | 60 | 120 | 180 | 300;
  feedbackMode: FeedbackMode;
  model: string;
  voice: string; // '' = persona default
  jobDescription: string;
  resume: string;
  targetRole: string;
  codeLanguage: string;
  focusAreas: string[]; // weakness tag ids to target ("practice my weak spots")
}

export type MessageRole = 'interviewer' | 'candidate' | 'event';
export type EventKind = 'start' | 'skip' | 'timeout' | 'wrapup' | 'resume';

export interface Message {
  id: number;
  sessionId: string;
  idx: number;
  role: MessageRole;
  content: string;
  createdAt: string;
  meta: {
    event?: EventKind;
    code?: string;
    codeLanguage?: string;
    notes?: string;
    timedOut?: boolean;
    model?: string;
  };
}

export interface StarCheck {
  applicable: boolean;
  situation: 'present' | 'partial' | 'missing';
  task: 'present' | 'partial' | 'missing';
  action: 'present' | 'partial' | 'missing';
  result: 'present' | 'partial' | 'missing';
  note: string;
}

export interface AnswerFeedback {
  id: number;
  sessionId: string;
  messageId: number;
  question: string;
  score: number; // 1-5
  summary: string;
  tips: string[];
  star: StarCheck;
  tags: string[];
  retried: boolean;
  createdAt: string;
}

export const CATEGORIES = [
  { id: 'communication', label: 'Communication' },
  { id: 'structure', label: 'Structure' },
  { id: 'technical_depth', label: 'Technical depth' },
  { id: 'problem_solving', label: 'Problem solving' },
  { id: 'role_fit', label: 'Role fit' },
] as const;
export type CategoryId = (typeof CATEGORIES)[number]['id'];

export const HIRE_SIGNALS = ['strong-no', 'no', 'lean-no', 'lean-yes', 'yes', 'strong-yes'] as const;
export type HireSignal = (typeof HIRE_SIGNALS)[number];

export interface Scorecard {
  overall_score: number; // 0-100
  hire_signal: HireSignal;
  summary: string;
  categories: Record<CategoryId, { score: number; comment: string }>; // 1-5
  strengths: string[];
  weaknesses: string[];
  weakness_tags: string[];
  questions: {
    question: string;
    answer_summary: string;
    score: number; // 1-5
    critique: string;
    improved_answer: string;
  }[];
  next_steps: string[];
}

export interface Usage {
  chat: { inputTokens: number; outputTokens: number; cost: number; calls: number };
  stt: { seconds: number; cost: number; calls: number };
  tts: { chars: number; cost: number; calls: number };
  total: number;
}

export const emptyUsage = (): Usage => ({
  chat: { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 },
  stt: { seconds: 0, cost: 0, calls: 0 },
  tts: { chars: 0, cost: 0, calls: 0 },
  total: 0,
});

export interface Session {
  id: string;
  createdAt: string;
  endedAt: string | null;
  status: 'active' | 'grading' | 'completed';
  config: SessionConfig;
  code: string;
  notes: string;
  elapsedSec: number;
  scorecard: Scorecard | null;
  overallScore: number | null;
  usage: Usage;
  title: string;
}

export interface SessionDetail extends Session {
  messages: Message[];
  feedback: AnswerFeedback[];
}

export const INTERVIEW_TYPES: { id: InterviewType; label: string; blurb: string }[] = [
  { id: 'behavioral', label: 'Behavioral', blurb: '“Tell me about a time…” questions, with STAR coaching.' },
  { id: 'coding', label: 'Technical / coding', blurb: 'A live problem in the code editor: approach, code, complexity.' },
  { id: 'system-design', label: 'System design', blurb: 'Open-ended architecture with a notes and diagram pad.' },
  { id: 'role-specific', label: 'Role-specific', blurb: 'Tailored to a job posting and your resume.' },
];

export const DIFFICULTIES: { id: Difficulty; label: string }[] = [
  { id: 'junior', label: 'Junior' },
  { id: 'mid', label: 'Mid' },
  { id: 'senior', label: 'Senior' },
  { id: 'staff', label: 'Staff+' },
];

export interface PersonaInfo {
  id: PersonaId;
  name: string;
  title: string;
  label: string;
  blurb: string;
  voice: string; // gpt-4o-mini-tts voice
  fallbackVoice: string; // Kokoro voice
  voiceInstructions: string;
}

export const PERSONAS: PersonaInfo[] = [
  {
    id: 'friendly-recruiter',
    name: 'Maya',
    title: 'Senior Talent Partner',
    label: 'Friendly recruiter',
    blurb: 'Warm and encouraging. Puts you at ease, but still listens for substance.',
    voice: 'coral',
    fallbackVoice: 'af_heart',
    voiceInstructions: 'Warm, upbeat and friendly. Conversational pace with a smile in the voice.',
  },
  {
    id: 'tough-manager',
    name: 'Daniel',
    title: 'Hiring Manager',
    label: 'Tough hiring manager',
    blurb: 'Direct, time-conscious and demanding. Interrupts fluff and wants results.',
    voice: 'onyx',
    fallbackVoice: 'am_michael',
    voiceInstructions: 'Direct, brisk and businesslike. Firm, slightly impatient, no filler.',
  },
  {
    id: 'skeptical-engineer',
    name: 'Priya',
    title: 'Principal Engineer',
    label: 'Skeptical senior engineer',
    blurb: 'Dry and probing. Questions every claim and asks “why?” until it holds up.',
    voice: 'sage',
    fallbackVoice: 'bf_emma',
    voiceInstructions: 'Measured, dry and thoughtful. Slightly skeptical, calm, deliberate pace.',
  },
  {
    id: 'neutral-faang',
    name: 'Alex',
    title: 'Software Engineer, Interview Panel',
    label: 'Neutral big-tech style',
    blurb: 'Calm, structured and by-the-book. Gives little away, like a standard loop.',
    voice: 'alloy',
    fallbackVoice: 'am_adam',
    voiceInstructions: 'Calm, neutral and professional. Even pace, clear articulation.',
  },
];

export const TTS_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

export const CHAT_MODELS = [
  { id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5 (best quality)' },
  { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (balanced)' },
  { id: 'anthropic/claude-haiku-5-5', label: 'Claude Haiku 5.5 (fast and cheap)' },
];

export const CODE_LANGUAGES = [
  { id: 'python', label: 'Python' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'java', label: 'Java' },
  { id: 'cpp', label: 'C++' },
  { id: 'go', label: 'Go' },
  { id: 'csharp', label: 'C#' },
  { id: 'rust', label: 'Rust' },
  { id: 'kotlin', label: 'Kotlin' },
  { id: 'swift', label: 'Swift' },
  { id: 'sql', label: 'SQL' },
];

// Fixed taxonomy of weak spots, so they can be counted across sessions.
export const WEAKNESS_TAGS: { id: string; label: string; hint: string }[] = [
  { id: 'vague-specifics', label: 'Vague specifics', hint: 'Give concrete, specific examples and details.' },
  { id: 'no-metrics', label: 'Impact not quantified', hint: 'Quantify results with numbers and metrics.' },
  { id: 'weak-structure', label: 'Weak structure', hint: 'Organize answers (STAR, signposting, top-down).' },
  { id: 'unclear-ownership', label: 'Unclear ownership', hint: 'Make clear what YOU did versus the team.' },
  { id: 'missing-result', label: 'Missing outcome', hint: 'Always land the result and what you learned.' },
  { id: 'answer-length', label: 'Answer length', hint: 'Keep answers focused: not rambling, not too thin.' },
  { id: 'shallow-tradeoffs', label: 'Shallow trade-offs', hint: 'Compare alternatives and justify choices.' },
  { id: 'requirements-gathering', label: 'Skipped clarifying questions', hint: 'Clarify requirements and constraints first.' },
  { id: 'complexity-analysis', label: 'Complexity analysis', hint: 'State and justify time and space complexity.' },
  { id: 'edge-cases-testing', label: 'Edge cases and testing', hint: 'Walk through edge cases and test your solution.' },
  { id: 'code-quality', label: 'Code quality', hint: 'Write clean, readable, correct code.' },
  { id: 'scalability-reasoning', label: 'Scalability reasoning', hint: 'Reason about scale, bottlenecks and failure modes.' },
  { id: 'problem-decomposition', label: 'Problem decomposition', hint: 'Break problems into parts before diving in.' },
  { id: 'role-alignment', label: 'Role alignment', hint: 'Connect your experience to the role’s needs.' },
  { id: 'communication-clarity', label: 'Communication clarity', hint: 'Think out loud clearly and concisely.' },
  { id: 'confidence', label: 'Confidence and hedging', hint: 'Speak with conviction; avoid excessive hedging.' },
];

export const tagLabel = (id: string) => WEAKNESS_TAGS.find((t) => t.id === id)?.label ?? id;
export const personaById = (id: PersonaId) => PERSONAS.find((p) => p.id === id) ?? PERSONAS[0];
export const typeLabel = (id: InterviewType) => INTERVIEW_TYPES.find((t) => t.id === id)?.label ?? id;

export const DEFAULT_CONFIG: SessionConfig = {
  type: 'behavioral',
  difficulty: 'mid',
  persona: 'friendly-recruiter',
  lengthMin: 30,
  answerTimerSec: 0,
  feedbackMode: 'both',
  model: 'anthropic/claude-opus-5-5',
  voice: '',
  jobDescription: '',
  resume: '',
  targetRole: '',
  codeLanguage: 'python',
  focusAreas: [],
};
