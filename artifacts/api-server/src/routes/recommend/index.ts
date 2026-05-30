import { Router, type IRouter } from "express";
import {
  RecommendByTextBody,
  RecommendByImageBody,
  GenerateInterestKeywordsBody,
  RecommendByKeywordBody,
  ChatWithPhilosopherBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────
interface KakaoBook {
  title: string;
  authors: string[];
  publisher: string;
  thumbnail: string;
  contents: string; // book description from Kakao
  isbn: string;
}

interface AiSelection {
  selectedIndex: number; // 0-based index into the books array
  empathyMessage: string;
  recommendationReason: string;
  thinkingQuestion: string;
  philosophyKnowledge: string; // 철학 돋보기 — grade-appropriate philosophical concept/anecdote
  philosopherName?: string;
  philosophicalLens?: string;
}

interface InterestKeywordOption {
  title: string;
  description: string;
  keyword: string;
}

interface ChatMessage {
  role: "student" | "philosopher";
  content: string;
}

type GeminiAi = typeof import("@workspace/integrations-gemini-ai")["ai"];

let warnedMissingGeminiEnv = false;

class GeminiUnavailableError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 503) {
    super(message);
    this.name = "GeminiUnavailableError";
    this.statusCode = statusCode;
  }
}

function hasGeminiConfig(): boolean {
  return Boolean(
    process.env.AI_INTEGRATIONS_GEMINI_BASE_URL &&
      process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
  );
}

function geminiErrorMessage(feature: string): string {
  return `${feature} 기능은 Gemini 연결이 필요해요. Render Environment Variables에 AI_INTEGRATIONS_GEMINI_API_KEY와 AI_INTEGRATIONS_GEMINI_BASE_URL이 제대로 들어갔는지 확인해 주세요.`;
}

function sendGeminiError(res: { status: (code: number) => { json: (body: unknown) => void } }, error: unknown): boolean {
  if (!(error instanceof GeminiUnavailableError)) return false;
  res.status(error.statusCode).json({
    error: error.message,
    aiSource: "gemini-unavailable",
  });
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasKoreanBatchim(text: string): boolean {
  const lastChar = text.trim().charAt(text.trim().length - 1);
  const code = lastChar.charCodeAt(0);
  return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
}

function withTopicParticle(text: string, withBatchim: string, withoutBatchim: string): string {
  return `${text}${hasKoreanBatchim(text) ? withBatchim : withoutBatchim}`;
}

function parseModelJson<T>(text: string): T {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const start = cleaned.search(/[\[{]/);
  const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  const jsonLike = start >= 0 && end >= start ? cleaned.slice(start, end + 1) : cleaned;
  const repaired = jsonLike
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/([{,]\s*)([A-Za-z_$가-힣][A-Za-z0-9_$가-힣]*)(\s*:)/g, '$1"$2"$3');
  try {
    return JSON.parse(repaired) as T;
  } catch (error) {
    const recovered = recoverModelJson(repaired);
    if (recovered) return recovered as T;

    console.warn("[recommend] Failed to parse Gemini JSON.", {
      message: error instanceof Error ? error.message : String(error),
      excerpt: repaired.slice(0, 500),
    });
    throw error;
  }
}

function extractStringField(source: string, field: string): string | undefined {
  const pattern = new RegExp(`"${field}"\\s*:\\s*"([\\s\\S]*?)(?:"\\s*[,}]|[,}])`);
  const value = source.match(pattern)?.[1]?.trim();
  return value ? value.replace(/\\n/g, "\n") : undefined;
}

function recoverModelJson(source: string): unknown | null {
  if (source.includes('"keywords"') && source.includes('"title"')) {
    const items = Array.from(source.matchAll(/{([^{}]*)}/g))
      .map((match) => {
        const chunk = match[0];
        const title = extractStringField(chunk, "title");
        const description = extractStringField(chunk, "description");
        const keyword = extractStringField(chunk, "keyword");
        return title && description && keyword
          ? { title, description, keyword }
          : null;
      })
      .filter(Boolean);

    if (items.length > 0) {
      return { keywords: items };
    }
  }

  if (source.includes('"keywords"')) {
    const keywordsBody = source.match(/"keywords"\s*:\s*\[([\s\S]*?)\]/)?.[1] ?? "";
    const keywords = Array.from(keywordsBody.matchAll(/"([^"]+)"/g)).map((match) => match[1]);
    if (keywords.length > 0) return { keywords };
  }

  if (source.includes('"reply"')) {
    const philosopherName = extractStringField(source, "philosopherName");
    const reply = extractStringField(source, "reply");
    if (reply) return { philosopherName: philosopherName ?? "소크라테스", reply };
  }

  if (source.includes('"recommendationReason"')) {
    const selectedIndex = Number(source.match(/"selectedIndex"\s*:\s*(\d+)/)?.[1] ?? 0);
    const empathyMessage = extractStringField(source, "empathyMessage");
    const recommendationReason = extractStringField(source, "recommendationReason");
    const philosophyKnowledge = extractStringField(source, "philosophyKnowledge");
    const thinkingQuestion = extractStringField(source, "thinkingQuestion");
    if (empathyMessage && recommendationReason && philosophyKnowledge && thinkingQuestion) {
      return {
        selectedIndex,
        empathyMessage,
        recommendationReason,
        philosophyKnowledge,
        thinkingQuestion,
      };
    }
  }

  return null;
}

async function getGeminiAi(): Promise<GeminiAi | null> {
  if (!hasGeminiConfig()) {
    if (!warnedMissingGeminiEnv) {
      warnedMissingGeminiEnv = true;
      console.warn(
        "[recommend] Gemini AI is not configured. Set AI_INTEGRATIONS_GEMINI_BASE_URL and AI_INTEGRATIONS_GEMINI_API_KEY to enable LLM-generated recommendation text.",
      );
    }
    return null;
  }

  try {
    const { ai } = await import("@workspace/integrations-gemini-ai");
    return ai;
  } catch {
    console.warn("[recommend] Gemini AI integration could not be loaded. Falling back to local generated text.");
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
// KAKAO BOOK SEARCH
// Returns up to `size` real books. Returns [] on any failure.
// ──────────────────────────────────────────────────────────────
type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

async function generateGeminiText(
  parts: GeminiPart[],
  maxOutputTokens: number,
  json = true,
  responseSchema?: unknown,
): Promise<string> {
  const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error("Gemini AI environment variables are not configured.");
  }

  const requestUrl = `${baseUrl.replace(/\/$/, "")}/models/gemini-2.5-flash:generateContent`;
  const requestBody = JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: {
      maxOutputTokens,
      ...(json ? { responseMimeType: "application/json" } : {}),
      ...(responseSchema ? { responseSchema } : {}),
    },
  });

  let response: Response | null = null;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetch(requestUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: requestBody,
      });

      if (response.ok) break;

      const body = await response.text();
      lastError = new Error(`Gemini API request failed (${response.status}): ${body.slice(0, 500)}`);

      if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === 3) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;
      if (attempt === 3) throw error;
    }

    await sleep(350 * attempt);
  }

  if (!response?.ok) {
    throw lastError instanceof Error ? lastError : new Error("Gemini API request failed.");
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();

  if (!text) {
    throw new Error("Gemini API returned no text.");
  }

  return text;
}

function fallbackInterestKeywordOptions(text: string): InterestKeywordOption[] {
  const topic = text.trim() || "궁금한 주제";
  const lastChar = topic.charAt(topic.length - 1);
  const code = lastChar.charCodeAt(0);
  const hasBatchim = code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0;
  const topicSubject = `${topic}${hasBatchim ? "은" : "는"}`;
  const topicWith = `${topic}${hasBatchim ? "과" : "와"}`;
  const topicObject = `${topic}${hasBatchim ? "을" : "를"}`;
  return [
    {
      title: `${topicSubject} 왜 소중할까?`,
      description: "좋아하는 주제가 우리 생활과 마음에 어떤 의미가 있는지 생각해 봐요.",
      keyword: `${topic} 가치 철학 동화`,
    },
    {
      title: `${topicWith} 함께 살기`,
      description: "사람, 자연, 세상이 서로 어떻게 이어져 있는지 탐구해 봐요.",
      keyword: `${topic} 관계 생각 그림책`,
    },
    {
      title: `${topicObject} 다르게 보기`,
      description: "당연해 보이는 것을 다시 묻고 새로운 관점으로 바라봐요.",
      keyword: `${topic} 질문 철학 그림책`,
    },
  ];
}

function normalizeInterestKeywordOptions(
  value: unknown,
  fallbackText: string,
): InterestKeywordOption[] {
  const rawItems =
    value && typeof value === "object" && Array.isArray((value as { keywords?: unknown }).keywords)
      ? (value as { keywords: unknown[] }).keywords
      : [];

  const normalized = rawItems
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const title = typeof record.title === "string" ? record.title.trim() : "";
      const description =
        typeof record.description === "string" ? record.description.trim() : "";
      const keyword = typeof record.keyword === "string" ? record.keyword.trim() : title;
      if (!title || !description || !keyword) return null;
      return { title, description, keyword };
    })
    .filter((item): item is InterestKeywordOption => item !== null)
    .slice(0, 3);

  if (normalized.length === 3) return normalized;

  const fallback = fallbackInterestKeywordOptions(fallbackText);
  return [...normalized, ...fallback].slice(0, 3);
}

async function generateInterestKeywordOptions(
  studentText: string,
): Promise<InterestKeywordOption[]> {
  if (!hasGeminiConfig()) {
    throw new GeminiUnavailableError(geminiErrorMessage("철학 탐구 키워드 생성"));
  }

  const prompt = `너는 초등학생을 위한 철학 사서야.

사용자의 관심사: "${studentText}"

이 관심사를 바로 도서 검색어로 쓰지 말고, 초등학교 3학년이 이해할 수 있는 철학적 탐구 키워드 3개로 바꿔 줘.

규칙:
- 반드시 3개만 만든다.
- 각 항목은 title, description, keyword를 가진다.
- title은 버튼에 들어갈 짧은 제목으로 쓴다.
- description은 초등 3학년이 이해할 수 있는 쉬운 설명 1문장으로 쓴다.
- keyword는 카카오 도서 검색에 바로 넣을 2~5단어 검색어로 쓴다.
- 특정 책 제목을 지어내지 않는다.
- JSON만 출력한다.

출력 형식:
{"keywords":[{"title":"...","description":"...","keyword":"..."},{"title":"...","description":"...","keyword":"..."},{"title":"...","description":"...","keyword":"..."}]}`;

  try {
    const cleanPrompt = `You are a philosophy librarian for Korean elementary school students.

Student interest: "${studentText}"

Create exactly 3 philosophical inquiry keyword options for a 3rd-grade elementary student.
Each option must be in Korean and must include:
- title: a short button title
- description: one easy sentence explaining the inquiry angle
- keyword: a Korean book-search query for Kakao Book Search

Return only JSON matching the provided schema.`;

    const text = await generateGeminiText([{ text: cleanPrompt }], 2048, true, {
      type: "OBJECT",
      properties: {
        keywords: {
          type: "ARRAY",
          minItems: 3,
          maxItems: 3,
          items: {
            type: "OBJECT",
            properties: {
              title: { type: "STRING" },
              description: { type: "STRING" },
              keyword: { type: "STRING" },
            },
            required: ["title", "description", "keyword"],
          },
        },
      },
      required: ["keywords"],
    });
    return normalizeInterestKeywordOptions(
      parseModelJson<unknown>(text),
      studentText,
    );
  } catch (error) {
    console.warn("[recommend] Gemini interest keyword generation failed.", {
      message: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof GeminiUnavailableError) throw error;
    throw new GeminiUnavailableError("Gemini가 철학 탐구 키워드를 만들지 못했어요. API 키와 Gemini 사용 가능 상태를 확인해 주세요.", 502);
  }
}

function inferPhilosopherName(context: string | null | undefined): string {
  const source = context ?? "";
  const candidates = [
    "소크라테스",
    "플라톤",
    "아리스토텔레스",
    "스피노자",
    "칸트",
    "공자",
    "맹자",
    "장자",
    "니체",
    "에피쿠로스",
    "스토아",
  ];
  return candidates.find((name) => source.includes(name)) ?? "소크라테스";
}

function fallbackPhilosopherReply(
  philosopherName: string,
  message: string,
  grade: "lower" | "higher",
): string {
  if (grade === "lower") {
    return `나는 ${philosopherName}처럼 질문을 좋아하는 철학 친구야. 네가 말한 "${message}"에서 가장 궁금한 마음 하나를 골라 보자. 왜 그렇게 생각했는지, 그리고 반대로 생각하면 어떤 일이 생길지 함께 물어보면 좋아.`;
  }

  return `나는 ${philosopherName}의 관점으로 함께 생각해 볼게. "${message}"라는 말 안에는 이미 중요한 철학 질문이 들어 있어. 먼저 네 생각의 근거를 하나 세우고, 그 근거가 모든 사람에게도 통할지 천천히 따져 보자.`;
}

async function chatWithPhilosopher({
  message,
  history = [],
  grade,
  bookTitle,
  bookAuthor,
  philosophyKnowledge,
  recommendationReason,
  thinkingQuestion,
}: {
  message: string;
  history?: ChatMessage[];
  grade: "lower" | "higher";
  bookTitle: string;
  bookAuthor?: string;
  philosophyKnowledge?: string | null;
  recommendationReason?: string;
  thinkingQuestion?: string;
}): Promise<{ philosopherName: string; reply: string }> {
  const philosopherName = inferPhilosopherName(philosophyKnowledge);

  if (
    !process.env.AI_INTEGRATIONS_GEMINI_BASE_URL ||
    !process.env.AI_INTEGRATIONS_GEMINI_API_KEY
  ) {
    return {
      philosopherName,
      reply: fallbackPhilosopherReply(philosopherName, message, grade),
    };
  }

  const historyText = history
    .slice(-8)
    .map((item) => `${item.role === "student" ? "학생" : philosopherName}: ${item.content}`)
    .join("\n");

  const gradeInstruction =
    grade === "lower"
      ? "초등학교 1~3학년도 이해할 수 있게 짧고 따뜻한 말로 답해라. 어려운 용어는 쉬운 생활 예시로 바꿔라."
      : "초등학교 4~6학년이 스스로 생각을 넓힐 수 있게 답해라. 개념은 정확하되 문장은 친절하게 써라.";

  const prompt = `너는 "${philosopherName}" 페르소나로 학생과 대화하는 철학 선생님이다.

추천된 책: ${bookTitle}${bookAuthor ? ` / ${bookAuthor}` : ""}
화면에 나온 철학자의 말 또는 철학 맥락:
${philosophyKnowledge ?? "(없음)"}

추천 이유:
${recommendationReason ?? "(없음)"}

마음 씨앗 질문:
${thinkingQuestion ?? "(없음)"}

대화 기록:
${historyText || "(아직 없음)"}

학생의 새 말:
${message}

규칙:
- ${gradeInstruction}
- 철학자 말투를 흉내 내되 과장하지 말고, 학생이 더 말하고 싶게 질문 1개로 마무리해라.
- 책의 내용, 추천 이유, 철학 맥락과 자연스럽게 연결해라.
- 정답을 단정하지 말고 학생이 스스로 생각하게 도와라.
- 2~4문장으로 답해라.
- JSON만 출력해라.

출력:
{"philosopherName":"${philosopherName}","reply":"..."}`;

  try {
    const text = await generateGeminiText([{ text: prompt }], 800, true, {
      type: "OBJECT",
      properties: {
        philosopherName: { type: "STRING" },
        reply: { type: "STRING" },
      },
      required: ["philosopherName", "reply"],
    });
    const parsed = parseModelJson<{ philosopherName?: string; reply?: string }>(
      text,
    );
    return {
      philosopherName: parsed.philosopherName?.trim() || philosopherName,
      reply:
        parsed.reply?.trim() ||
        fallbackPhilosopherReply(philosopherName, message, grade),
    };
  } catch (error) {
    console.warn("[recommend] Gemini philosopher chat failed.", {
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      philosopherName,
      reply: fallbackPhilosopherReply(philosopherName, message, grade),
    };
  }
}

async function searchKakaoBooks(
  query: string,
  size = 5,
  log?: import("pino").Logger
): Promise<KakaoBook[]> {
  const apiKey = process.env.KAKAO_API_KEY;
  if (!apiKey) {
    log?.warn("KAKAO_API_KEY is not set");
    return [];
  }

  const url = new URL("https://dapi.kakao.com/v3/search/book");
  url.searchParams.set("query", query);
  url.searchParams.set("size", String(size));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const resp = await fetch(url.toString(), {
      headers: { Authorization: `KakaoAK ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      log?.warn({ status: resp.status, body }, "Kakao API non-OK response");
      return [];
    }

    const json = (await resp.json()) as { documents: KakaoBook[] };
    const filtered = (json.documents ?? []).filter((b) => b.thumbnail && b.title);
    log?.info({ query, total: json.documents?.length, filtered: filtered.length }, "Kakao search done");
    return filtered;
  } catch (err) {
    clearTimeout(timeout);
    log?.warn({ err, query }, "Kakao API fetch failed");
    return [];
  }
}

// ──────────────────────────────────────────────────────────────
// STEP 1 — AI generates search keywords (never picks a book)
// ──────────────────────────────────────────────────────────────
async function generateSearchKeywords(
  studentText: string,
  grade: "lower" | "higher",
  searchType: "emotion" | "interest" = "emotion"
): Promise<string[]> {
  if (
    !process.env.AI_INTEGRATIONS_GEMINI_BASE_URL ||
    !process.env.AI_INTEGRATIONS_GEMINI_API_KEY
  ) {
    return fallbackKeywords(studentText, grade, searchType);
  }

  if (
    !process.env.AI_INTEGRATIONS_GEMINI_BASE_URL ||
    !process.env.AI_INTEGRATIONS_GEMINI_API_KEY
  ) {
    return fallbackKeywords(studentText, grade, searchType);
  }

  const isLower = grade === "lower";

  // Use a timestamp-seeded jitter phrase so the AI varies its output on repeated calls
  const jitterSeed = Date.now() % 100;

  if (searchType === "interest") {
    const gradeCtx = isLower
      ? "초등 저학년(1~3학년) — 이야기체 그림책·동화로 철학·과학 원리를 접하는 나이"
      : "초등 고학년(4~6학년) — 인문학·교양·고전으로 세계관을 확장하는 나이";

    const philosophyBridgeExamples = isLower
      ? `우주→"우주 속 나는 얼마나 특별한가", 역사→"옛사람들은 어떻게 생각했을까", 공룡→"사라진다는 것의 의미", 요리→"음식과 인간의 관계"`
      : `우주→"존재의 의미·인류의 위치", 역사→"비판적 사고·시각의 진화", 로봇→"인간다움이란 무엇인가", 환경→"자연과 공존의 윤리"`;

    const dynamicTags = isLower
      ? ["철학 그림책", "원리 동화", "생각하는 과학", "가치 이야기", "탐구 그림책", "어린이 인문"][jitterSeed % 6]
      : ["인문학 교양", "철학 에세이", "생각의 역사", "비판적 사고", "어린이 고전", "지식 탐구"][jitterSeed % 6];

    const prompt = `당신은 철학·인문학 아동도서 전문 사서입니다. (탐색 세션 #${jitterSeed})

학생의 관심 주제: "${studentText}"
대상 독자: ${gradeCtx}

━━━ 1단계: 철학적 차원 연결 ━━━
단순한 사실 탐구가 아닌, 이 주제가 품고 있는 더 큰 철학적·인문학적 질문을 파악하세요.
예시 매핑: ${philosophyBridgeExamples}

"${studentText}" 주제의 핵심 철학적 차원: (내부 분석 — 출력 불필요)

━━━ 2단계: 다이내믹 검색어 생성 ━━━
위 분석을 바탕으로 카카오 도서 검색에 최적화된 키워드 2개를 생성하세요.

★ 필수 규칙:
- 반드시 2~4 단어로 짧게 (5단어 이상이면 검색 결과 0개)
- [주제어 또는 개념어] + [${dynamicTags}] 형식으로 조합
- 이번 세션에서는 "어린이 ${studentText.slice(0, 4)}"처럼 직관적인 조합 외에 더 추상적이고 참신한 각도도 시도할 것
- 책 제목 직접 사용 금지

JSON만 출력:
{"keywords": ["키워드1", "키워드2"]}`;

    try {
      const text = await generateGeminiText([{ text: prompt }], 200, true, {
        type: "OBJECT",
        properties: {
          keywords: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["keywords"],
      });
      const parsed = parseModelJson<{ keywords: string[] }>(text);
      const kws = (parsed.keywords ?? []).filter(Boolean);
      return kws.length >= 1 ? kws : fallbackKeywords(studentText, grade, searchType);
    } catch {
      return fallbackKeywords(studentText, grade, searchType);
    }
  }

  // ── emotion mode ──────────────────────────────────────────────
  const gradeContext = isLower
    ? "저학년(1~3학년) — 선악·우정·용기·정직 같은 보편 가치와 철학적 질문을 다루는 철학 동화·그림책"
    : "고학년(4~6학년) — 서양/동양 철학(소크라테스·플라톤·노자·니체·스피노자·스토아학파 등), 윤리 딜레마, 비판적 사고를 다루는 어린이 인문학·철학 교양서";

  const dynamicTagEmotion = isLower
    ? ["철학 동화", "가치 그림책", "인성 이야기", "마음 성장", "생각 그림책", "윤리 동화"][jitterSeed % 6]
    : ["인문학 교양", "철학 에세이", "윤리 탐구", "마음 철학", "어린이 고전", "사고력 인문"][jitterSeed % 6];

  const prompt = `당신은 철학·인문학 아동도서 전문 사서입니다. (탐색 세션 #${jitterSeed})

학생의 고민/감정: "${studentText}"
대상 독자: ${gradeContext}

━━━ 1단계: 감정의 근본 원인 분석 ━━━
표면적 감정 뒤에 숨어 있는 깊은 심리적·철학적 차원을 파악하세요.

예시 분석:
- "친구가 질투 나요" → 비교 의식 + 자기 가치 + 숨겨진 동경 → 스피노자의 감정론 / 스토아 회복탄력성
- "화가 나요" → 경계 침해 + 정의감 + 통제 욕구 → 아리스토텔레스의 분노론 / 칸트의 자율성
- "슬퍼요" → 상실감 + 무상함 + 연결 욕구 → 불교적 무상(無常) / 실존주의
- "외로워요" → 관계 결핍 + 정체성 불안 → 공자의 인(仁) / 마르틴 부버의 '나-너' 관계론

"${studentText}"의 근본 원인 + 철학적 프레임워크: (내부 분석 — 출력 불필요)

━━━ 2단계: 다이내믹 검색어 생성 ━━━
위 분석을 바탕으로, 단순히 감정 단어를 그대로 쓰는 것이 아닌
해당 감정의 철학적 핵심 개념을 담은 키워드 2개를 생성하세요.

★ 필수 규칙:
- 반드시 2~4 단어로 짧게
- [핵심 가치/개념어] + [${dynamicTagEmotion}] 조합
- 이번 세션에서는 익숙한 조합 외에 더 참신하고 다각적인 각도도 시도할 것
- 책 제목 직접 사용 금지

JSON만 출력:
{"keywords": ["키워드1", "키워드2"]}`;

  try {
    const text = await generateGeminiText([{ text: prompt }], 200, true, {
      type: "OBJECT",
      properties: {
        keywords: { type: "ARRAY", items: { type: "STRING" } },
      },
      required: ["keywords"],
    });
    const parsed = parseModelJson<{ keywords: string[] }>(text);
    const kws = (parsed.keywords ?? []).filter(Boolean);
    return kws.length >= 1 ? kws : fallbackKeywords(studentText, grade, searchType);
  } catch (error) {
    console.warn("[recommend] Gemini search keyword generation failed.", {
      message: error instanceof Error ? error.message : String(error),
    });
    return fallbackKeywords(studentText, grade, searchType);
  }
}

function fallbackKeywords(
  text: string,
  grade: "lower" | "higher",
  searchType: "emotion" | "interest" = "emotion"
): string[] {
  if (searchType === "interest") {
    // interest-mode fallbacks: combine the topic with philosophy/science/history
    if (grade === "lower") {
      if (/우주|별|행성|로켓/.test(text)) return ["어린이 우주 과학", "초등 과학 그림책"];
      if (/공룡|화석|고생물/.test(text)) return ["공룡 어린이 과학", "초등 자연 그림책"];
      if (/역사|왕|조선|고대/.test(text)) return ["어린이 역사 동화", "초등 역사 그림책"];
      if (/로봇|기계|발명/.test(text)) return ["어린이 발명 과학", "초등 기술 그림책"];
      if (/요리|음식|맛/.test(text)) return ["초등 과학 요리", "어린이 음식 그림책"];
      return ["초등 원리 그림책", "어린이 생각 과학"];
    } else {
      if (/우주|별|행성|물리/.test(text)) return ["어린이 우주 과학사", "초등 인문학 과학"];
      if (/역사|세계사|전쟁|왕조/.test(text)) return ["어린이 역사 인문학", "청소년 세계사"];
      if (/로봇|AI|기술|코딩/.test(text)) return ["어린이 철학 기술", "청소년 교양 과학"];
      if (/환경|생태|지구/.test(text)) return ["어린이 환경 인문학", "초등 생태 교양"];
      return ["초등 인문학 고전", "어린이 생각의 역사"];
    }
  }
  // emotion mode (original)
  if (grade === "lower") {
    if (/친구|싸움|질투|속상/.test(text)) return ["초등 철학동화", "생각하는 그림책"];
    if (/틀리|실수|불안|용기/.test(text)) return ["어린이 인성 동화", "초등 용기 철학동화"];
    if (/욕심|착한|도덕|약속/.test(text)) return ["어린이 가치 사전", "초등 도덕 그림책"];
    return ["초등 저학년 철학동화", "생각하는 그림책"];
  } else {
    if (/억울|공정|규칙|법/.test(text)) return ["어린이 정의 철학", "초등 윤리 인문학"];
    if (/생각|질문|이유|공부/.test(text)) return ["어린이 소크라테스", "초등 철학"];
    if (/친구|외로|다름|왕따/.test(text)) return ["어린이 인문학", "초등 철학"];
    if (/돈|욕심|행복/.test(text)) return ["만화 도덕경", "어린이 동양철학"];
    return ["초등 고학년 철학", "어린이 인문학"];
  }
}

// ──────────────────────────────────────────────────────────────
// STEP 2a — Hard filter: strip lower-grade books from higher results.
// "만화" / "웹툰" are explicitly allowed (e.g. 만화 도덕경).
// ──────────────────────────────────────────────────────────────
const LOWER_GRADE_PATTERNS =
  /저학년|유아|아기|1학년|2학년|3학년|누리과정|그림책|유치원|어린이집|뽀|뽀뽀/i;

function isLowerGradeBook(book: KakaoBook): boolean {
  const haystack = `${book.title} ${book.contents ?? ""}`;
  return LOWER_GRADE_PATTERNS.test(haystack);
}

function filterForGrade(books: KakaoBook[], grade: "lower" | "higher"): KakaoBook[] {
  if (grade === "lower") return books; // no filtering needed for lower
  const filtered = books.filter((b) => !isLowerGradeBook(b));
  // keep at least 1 book so we never return an empty list from a non-empty input
  return filtered.length > 0 ? filtered : books;
}

// ──────────────────────────────────────────────────────────────
// STEP 2 — Fetch real books from Kakao using the keywords
// Tries each keyword in order, deduplicates by title, returns up to 5
// ──────────────────────────────────────────────────────────────
async function fetchRealBooks(
  keywords: string[],
  grade: "lower" | "higher",
  log?: import("pino").Logger
): Promise<KakaoBook[]> {
  const seen = new Set<string>();
  const combined: KakaoBook[] = [];

  const addBooks = (raw: KakaoBook[]) => {
    const filtered = filterForGrade(raw, grade);
    for (const book of filtered) {
      if (combined.length >= 5) break;
      const key = book.isbn || book.title;
      if (!seen.has(key)) {
        seen.add(key);
        combined.push(book);
      }
    }
  };

  // Try provided keywords first
  for (const kw of keywords) {
    if (combined.length >= 5) break;
    const raw = await searchKakaoBooks(kw, 8, log); // fetch extra to absorb filtered ones
    addBooks(raw);
  }

  // If still empty, retry with grade-appropriate broad keywords
  if (combined.length === 0) {
    log?.warn({ keywords, grade }, "No results, retrying with broad fallback");
    const broadFallbacks =
      grade === "lower"
        ? ["어린이 철학", "초등 철학동화", "감정 그림책"]
        : ["초등 철학", "어린이 인문학", "청소년 철학"];
    for (const kw of broadFallbacks) {
      if (combined.length >= 5) break;
      const raw = await searchKakaoBooks(kw, 8, log);
      addBooks(raw);
    }
  }

  return combined;
}

// ──────────────────────────────────────────────────────────────
// STEP 3 — AI picks the best book from real results + writes text
// The AI can ONLY choose from the list it receives. No invented books.
// ──────────────────────────────────────────────────────────────
async function selectAndDescribe(
  studentText: string,
  books: KakaoBook[],
  grade: "lower" | "higher",
  searchType: "emotion" | "interest" = "emotion"
): Promise<{ book: KakaoBook; text: Omit<AiSelection, "selectedIndex"> }> {
  const gradeLabel = grade === "lower" ? "저학년 (1~3학년)" : "고학년 (4~6학년)";
  const isLower = grade === "lower";

  const bookList = books
    .map(
      (b, i) =>
        `[${i}] 제목: ${b.title}\n    저자: ${b.authors.join(", ")}\n    출판사: ${b.publisher}\n    소개: ${b.contents?.slice(0, 150) || "(소개 없음)"}`
    )
    .join("\n\n");

  const selectionCriteria = isLower
    ? `━━━ 저학년(1~3학년) 선택 기준 ━━━

🔍 숨겨진 명작 우선 원칙:
- "베스트셀러"나 "가장 유명한" 책이 아니라, 실제로 철학적 가치가 담긴 책을 찾을 것
- 단순한 생활 에피소드("나는 화가 났어요")나 유아 감정 일기류는 반드시 제외
- 소크라테스식 질문·대화, 윤리적 선택 상황, 가치 탐구 실험이 담긴 책 적극 선택

✅ 우선 선택:
- 선악·우정·용기·정직·자유의지 등 보편적 철학 가치를 이야기로 풀어낸 책
- 어린이가 "왜?"라고 생각하게 만드는 장치(딜레마·반전·질문)가 있는 책
- 단순 도덕 교훈("착하게 살아야 해")이 아닌, 열린 결말이나 사고를 유발하는 책

⛔ 선택 금지:
- 유아 대상(0~5세) 감정 표현 책
- 단순 생활습관·예절 교육서
- 뻔한 "착한 일 하면 칭찬받아요" 식의 도덕 교과서류`
    : `━━━ 고학년(4~6학년) 선택 기준 — 최고 엄격도 적용 ━━━

🔍 숨겨진 명작 우선 원칙:
- 가장 많이 팔린 책이 아니라, 실제로 철학적 깊이가 있는 책을 찾을 것
- 목록에서 "겉으로는 평범해 보이지만 안에 진짜 철학적 질문이 담긴" 책을 발굴할 것
- 아름답게 쓰인 각색 고전, 사고를 자극하는 그래픽 노블, 윤리적 딜레마를 제시하는 책 적극 선택

✅ 반드시 우선:
- 소크라테스·플라톤·아리스토텔레스·노자·장자·니체·스피노자·칸트·스토아학파 등 실제 사상가의 핵심 개념을 소개하는 책
- 만화·웹툰 형식이라도 진짜 철학 내용이 담기면 선택 가능 (만화 도덕경, 어린이 정의론 등)
- 윤리적 딜레마 또는 비판적 사고를 요구하는 열린 질문을 제시하는 책

⛔ 절대 선택 금지:
- 그림책·저학년 동화·유아 감정책·1~3학년 대상 도서
- 단순 자기계발·동기부여·라이프스타일서 ("긍정적으로 살아요", "실수해도 괜찮아" 수준)
- 단순 도덕 교훈으로 끝나는 책 (진짜 철학적 탐구 없이 "착하게 살아야 해"로 마무리되는 책)
- 뻔한 베스트셀러를 단지 유명하다는 이유로 선택하지 말 것`;

  const isInterest = searchType === "interest";

  const studentContextLine = isInterest
    ? `학생의 관심 주제: "${studentText}"`
    : `학생의 고민/감정: "${studentText}"`;

  // ── Build deep-analysis context block ────────────────────────
  const depthAnalysisBlock = isInterest
    ? `━━━ 학생 관심사 심층 분석 (내부 분석 — JSON에 포함하지 말 것) ━━━
관심 주제: "${studentText}"
분석 방향:
1. 이 주제가 품고 있는 실존적·철학적 질문은 무엇인가?
   예) 우주 → "나는 왜 존재하는가? 우주 속 인간의 위치" / 역사 → "과거는 어떻게 현재를 규정하는가? 비판적 사고의 진화"
2. 어떤 철학 사조 또는 사상가가 이 주제와 연결되는가?
3. 이 주제를 탐구하면 어떤 사고 능력이 성장하는가?
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    : `━━━ 학생 감정 다층 분석 (내부 분석 — JSON에 포함하지 말 것) ━━━
표면 감정: "${studentText}"
분석 방향:
1. 이 감정의 표면 아래 숨어 있는 근본 원인(root cause)은 무엇인가?
   예) "질투" → 비교 의식 + 자기 가치 + 숨겨진 동경
   예) "화남" → 경계 침해 + 정의감 + 통제 욕구
   예) "외로움" → 관계 결핍 + 정체성 불안
2. 이 감정과 연결되는 철학적 프레임워크는?
   예) 스피노자의 감정론, 스토아 회복탄력성, 아리스토텔레스의 분노론, 불교적 무상(無常), 공자의 인(仁)
3. 이 근본 원인을 탐구하기에 가장 적합한 책은 무엇인가?
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

  // ── Per-field writing instructions ───────────────────────────
  const empathySpec = isInterest
    ? (isLower
        ? `1~2문장. 학생의 호기심을 따뜻하고 구체적으로 칭찬. 단순한 "잘했어요" 대신 그 호기심이 왜 소중한지 말해줄 것. 저학년 어휘 사용.`
        : `1~2문장. 관심사를 지적 탐구의 출발점으로 인정. "그 질문은 수천 년간 철학자들도 품어왔던 거야" 식의 격려. 고학년에게 어울리는 지적인 톤.`)
    : (isLower
        ? `1~2문장. 표면 감정이 아닌 근본 원인까지 꿰뚫는 깊은 공감. 어린이 말투로 따뜻하게. "그럴 수 있어"가 아닌, 왜 그 감정이 드는지 이해한다는 뉘앙스.`
        : `1~2문장. 감정의 표면 너머를 보는 철학적 공감. "그 감정이 사실은 더 깊은 질문을 담고 있어"라는 인식. 고학년 어휘, 가볍지 않은 톤.`);

  const reasonSpec = isInterest
    ? (isLower
        ? `2~3문장. 이 책이 관심사를 단순 사실 너머의 철학적 차원으로 연결해주는 방식 설명. 쉽고 재미있게. 과학·역사·인문 개념 포함.`
        : `2~3문장. 이 책이 관심사를 실제 철학·인문학적 사고로 확장하는 방식 설명. 실제 사상가·과학자·역사적 개념 반드시 자연스럽게 포함. 지적 호기심을 자극하는 서술.`)
    : (isLower
        ? `2~3문장. 위에서 분석한 감정의 근본 원인을 이 책이 어떻게 다루는지 연결. 철학적 가치(선악·용기·우정·자유 등)를 쉽고 구체적으로 풀어낼 것. 뻔한 위로 금지.`
        : `2~3문장. 감정의 철학적 프레임워크와 이 책의 핵심 질문을 정확히 연결. 구체적 사상가·학파·개념 명시 필수 (예: "스토아학파", "스피노자의 감정 이론", "칸트의 자율성"). 지적 자극 우선.`);

  const philosophySpec = isLower
    ? `2~4문장. 이 책과 연결된 철학 개념을 친근한 이야기·에피소드 형식으로. '소크라테스 할아버지는요...', '아주 오래전 그리스에...', '옛날 어떤 철학자는...' 식으로 시작. 딱딱한 개념 정의 절대 금지. 반드시 어린이가 "아 그렇구나!" 하고 느낄 수 있는 구체적 이야기.`
    : `3~5문장. 이 책과 연결된 실제 철학 개념·용어·사상가를 지적이고 자연스럽게 소개. '도덕경의 무위자연이란...', '플라톤의 동굴 비유에서...', '스피노자는 감정을 이렇게 보았다...' 처럼 실제 철학 용어와 사고 틀을 풀어 쓸 것. 백과사전식 나열 금지, 반드시 학생의 관심사/감정과 연결된 맥락으로.`;

  const questionSpec = isInterest
    ? (isLower
        ? `1~2개. 관심 주제를 더 탐구하게 만드는 호기심 유발 질문. 단답형 금지, 반드시 열린 질문.`
        : `1~2개. 관심 주제와 철학·과학사·인문학을 연결하는 깊은 사고 질문. 정답이 없는 열린 딜레마 또는 반론 가능한 명제 형식 권장.`)
    : (isLower
        ? `1~2개. 위에서 분석한 감정의 근본 원인과 연결된 철학적 질문. 일상에서 스스로 답해볼 수 있도록 구체적인 상황 제시. 열린 결말형.`
        : `1~2개. 감정의 철학적 프레임워크와 연결된 깊은 딜레마 또는 비판적 사고 질문. 사상가의 관점을 빌리거나 핵심 철학 개념과 연결. 단순 감정 확인 절대 금지.`);

  const prompt = `당신은 초등학생을 위한 철학·인문학 전문 사서입니다.

학생 학년: ${gradeLabel}
${studentContextLine}

${depthAnalysisBlock}

━━━ 실제 도서 목록 (이 목록 외 책은 절대 언급 금지) ━━━
${bookList}

${selectionCriteria}

━━━ 집필 지침 ━━━
위 분석과 선택 기준을 바탕으로, 가장 적합한 책 1권을 고르고 아래 네 항목을 작성하세요.

📌 핵심 원칙:
- 모든 답변은 단순 감정 위로를 넘어 철학·인문학적 관점으로 반드시 연결할 것
- 추천 이유에 구체적 철학자·학파·개념 명시는 의무 사항 (예: "스토아학파", "스피노자", "칸트의 의무론")
- 철학 돋보기는 이 책 + 이 학생의 상황에 맞게 커스터마이즈 — 재사용 금지
- 마음 씨앗 질문은 정답이 없는 진짜 열린 철학적 딜레마여야 함

JSON만 출력하세요. 다른 텍스트 없이 JSON만:
{
  "selectedIndex": (선택한 책의 번호, 0부터 시작하는 숫자),
  "empathyMessage": "(${empathySpec})",
  "recommendationReason": "(${reasonSpec})",
  "philosophyKnowledge": "(${philosophySpec})",
  "thinkingQuestion": "(${questionSpec})"
}`;

  if (
    !process.env.AI_INTEGRATIONS_GEMINI_BASE_URL ||
    !process.env.AI_INTEGRATIONS_GEMINI_API_KEY
  ) {
    return {
      book: books[0],
      text: genericText(books[0], grade, studentText, searchType),
    };
  }

  if (
    !process.env.AI_INTEGRATIONS_GEMINI_BASE_URL ||
    !process.env.AI_INTEGRATIONS_GEMINI_API_KEY
  ) {
    return {
      book: books[0],
      text: genericText(books[0], grade, studentText, searchType),
    };
  }

  try {
    const cleanBookList = books
      .map(
        (book, index) =>
          `[${index}] Title: ${book.title}
Authors: ${book.authors.join(", ")}
Publisher: ${book.publisher || "(none)"}
Description: ${book.contents || "(none)"}`,
      )
      .join("\n\n");
    const cleanPrompt = `You are a warm philosophy book recommender for Korean elementary school students.

Student grade group: ${grade === "lower" ? "grades 1-3" : "grades 4-6"}
Student input or selected inquiry keyword: "${studentText}"
Search mode: ${searchType}

Choose exactly one book from this real Kakao Book Search result list. Do not invent books.

${cleanBookList}

Write all text fields in Korean for the student.
The writing must be specific to the chosen book and the student's input. Do not reuse generic Socrates-only fallback text.
Connect the book to a philosopher, philosophical concept, or philosophical question that fits the book.

Return only JSON matching the provided schema.`;

    const text = await generateGeminiText([{ text: cleanPrompt }], 8192, true, {
      type: "OBJECT",
      properties: {
        selectedIndex: { type: "INTEGER" },
        empathyMessage: { type: "STRING" },
        recommendationReason: { type: "STRING" },
        philosophyKnowledge: { type: "STRING" },
        thinkingQuestion: { type: "STRING" },
      },
      required: [
        "selectedIndex",
        "empathyMessage",
        "recommendationReason",
        "philosophyKnowledge",
        "thinkingQuestion",
      ],
    });
    const result = parseModelJson<AiSelection>(text);

    // Validate the index — if AI hallucinated an out-of-range index, use 0
    const idx = Number.isInteger(result.selectedIndex) &&
      result.selectedIndex >= 0 &&
      result.selectedIndex < books.length
        ? result.selectedIndex
        : 0;

    const book = books[idx];
    return {
      book,
      text: {
        empathyMessage: result.empathyMessage,
        recommendationReason: result.recommendationReason,
        thinkingQuestion: result.thinkingQuestion,
        philosophyKnowledge: result.philosophyKnowledge ?? null,
      },
    };
  } catch (error) {
    console.warn("[recommend] Gemini recommendation text generation failed.", {
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      book: books[0],
      text: genericText(books[0], grade, studentText, searchType),
    };
  }
}

function genericText(
  book: KakaoBook,
  grade: "lower" | "higher",
  studentText = "",
  searchType: "emotion" | "interest" = "emotion",
): Omit<AiSelection, "selectedIndex"> {
  const title = book.title.replace(/<[^>]+>/g, "").trim();
  const author = book.authors[0] ? `${book.authors[0]} 작가의 ` : "";
  const rawTopic = studentText.replace(/^학생의 관심사\s*/, "").trim() || title;
  const topic = rawTopic
    .replace(/^"(.+)"에서 고른 철학 탐구 키워드 "(.+)"에 맞는 책을 추천해줘\.?$/, "$2")
    .replace(/^철학 탐구 키워드 "(.+)"에 맞는 책을 추천해줘\.?$/, "$1")
    .replace(/(이|가)?\s*궁금해요\.?$/, "")
    .trim() || rawTopic;
  const topicObject = withTopicParticle(topic, "을", "를");
  const topicSubject = withTopicParticle(topic, "이", "가");
  const seed = Array.from(`${title}${topic}`).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const philosophers = [
    {
      name: "소크라테스",
      idea: "스스로 질문하며 생각을 깊게 만드는 일",
      lowerStory: "소크라테스 할아버지는 정답을 바로 말하기보다 '왜 그렇게 생각하니?' 하고 다시 물어보곤 했대요.",
      upperStory: "소크라테스는 좋은 삶이란 남의 답을 외우는 것이 아니라, 자기 생각의 이유를 계속 묻는 데서 시작한다고 보았어요.",
    },
    {
      name: "아리스토텔레스",
      idea: "좋은 습관과 균형을 찾는 일",
      lowerStory: "아리스토텔레스는 용기도, 친절도, 지혜도 조금씩 연습하며 자란다고 생각했어요.",
      upperStory: "아리스토텔레스는 좋은 삶을 한 번의 선택이 아니라 반복되는 습관과 균형의 문제로 보았어요.",
    },
    {
      name: "스피노자",
      idea: "마음의 원인을 이해하면 더 자유로워진다는 생각",
      lowerStory: "스피노자는 마음이 왜 흔들리는지 알면 그 마음과 조금 더 잘 지낼 수 있다고 보았어요.",
      upperStory: "스피노자는 감정을 억누르기보다 그 감정이 생긴 원인을 이해할 때 더 자유로워질 수 있다고 말했어요.",
    },
    {
      name: "공자",
      idea: "나와 다른 사람이 함께 잘 살아가는 길",
      lowerStory: "공자는 혼자 똑똑한 것보다 친구와 가족을 배려하며 자라는 마음을 중요하게 여겼어요.",
      upperStory: "공자는 사람다운 삶이란 관계 속에서 예의와 배려를 배우고 실천하는 과정이라고 보았어요.",
    },
    {
      name: "칸트",
      idea: "내 행동이 모두에게도 괜찮은 규칙인지 따져보는 일",
      lowerStory: "칸트는 '내가 한 행동을 모두가 따라 해도 괜찮을까?' 하고 생각해 보라고 말했어요.",
      upperStory: "칸트는 어떤 선택이 옳은지 보려면 그 선택이 모두에게 적용되어도 괜찮은 원칙인지 따져야 한다고 보았어요.",
    },
  ];
  const philosopher = philosophers[seed % philosophers.length];
  const isInterest = searchType === "interest";

  if (grade === "lower") {
    return {
      empathyMessage: isInterest
        ? `${topicSubject} 궁금하다는 건 아주 멋진 출발이에요. 그 궁금함을 따라가다 보면 나만의 생각이 조금씩 자라날 수 있어요.`
        : `${topic}이라는 마음 안에는 네가 소중히 여기는 것이 숨어 있을 수 있어요. 그 마음을 천천히 살펴보는 것도 좋은 생각이에요.`,
      recommendationReason: `《${title}》은 ${author}이야기를 통해 ${isInterest ? "궁금한 주제를 그냥 정보로 외우는 대신, 스스로 질문해 보게" : "지금 마음을 다른 눈으로 바라보게"} 도와줄 수 있어요. 책 속 인물이나 장면을 따라가며 "${philosopher.idea}"을 쉽게 떠올려 볼 수 있습니다.`,
      thinkingQuestion: isInterest
        ? `${topicObject} 더 잘 알고 싶다면, 나는 먼저 어떤 질문부터 해 보고 싶나요?`
        : `내 마음이 이렇게 말하는 까닭은 무엇이고, 그 마음은 나에게 무엇을 알려주려는 걸까요?`,
      philosophyKnowledge: `${philosopher.lowerStory} 《${title}》을 읽을 때도 바로 답을 찾으려 하기보다, 책 속 장면에서 '${philosopher.idea}'을 찾아보면 좋아요. 그렇게 묻는 순간, 책 읽기는 작은 철학 탐험이 됩니다.`,
    };
  }
  return {
    empathyMessage: isInterest
      ? `${topicSubject} 마음을 끈다는 건 이미 세상을 더 깊게 이해하고 싶다는 신호일 수 있어요. 그 호기심을 질문으로 바꾸면 훨씬 단단한 탐구가 됩니다.`
      : `${topic}이라는 고민을 그냥 넘기지 않고 들여다보는 태도 자체가 철학적인 출발점이에요. 지금 필요한 건 빠른 정답보다 생각을 정리할 시간일 수 있습니다.`,
    recommendationReason: `《${title}》은 ${author}${isInterest ? "관심사를 넓은 철학 질문으로 확장하는 데" : "지금의 감정과 고민을 한 걸음 떨어져 바라보는 데"} 도움이 됩니다. 특히 ${philosopher.name}의 관점으로 보면 이 책은 '${philosopher.idea}'이라는 질문과 연결되어 읽힐 수 있어요.`,
    thinkingQuestion: isInterest
      ? `${topicObject} 탐구할 때, 나는 사실 무엇을 알고 싶은 걸까요: 사실, 의미, 관계, 아니면 내가 해야 할 선택일까요?`
      : `이 고민 앞에서 내가 지키고 싶은 가치는 무엇이며, 그 가치는 다른 사람에게도 설득될 수 있을까요?`,
    philosophyKnowledge: `${philosopher.upperStory} 그래서 《${title}》을 읽을 때는 줄거리만 따라가기보다, 인물의 선택과 갈등이 '${philosopher.idea}'과 어떻게 이어지는지 살펴보면 좋아요. 그 지점에서 이 책은 단순한 추천 도서가 아니라 생각을 훈련하는 철학 텍스트가 됩니다.`,
  };
}

interface RecommendationContext {
  sourceText: string;
  selectedKeyword?: string;
  searchMode: "emotion" | "interest" | "image";
}

function uniqueStrings(values: Array<string | null | undefined>, limit = 8): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = value?.replace(/\s+/g, " ").trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
    if (result.length >= limit) break;
  }
  return result;
}

function cleanPhilosopherName(context: string | null | undefined): string {
  const source = context ?? "";
  const names = [
    "소크라테스",
    "플라톤",
    "아리스토텔레스",
    "스피노자",
    "칸트",
    "공자",
    "맹자",
    "노자",
    "니체",
    "에피쿠로스",
    "스토아",
  ];
  return names.find((name) => source.includes(name)) ?? "소크라테스";
}

function contextualFallbackSearchTerms(
  topic: string,
  selectedKeyword: string,
  grade: "lower" | "higher",
): string[] {
  return uniqueStrings(
    [
      selectedKeyword,
      `${topic} 동화`,
      `${topic} 어린이`,
      `${topic} 그림책`,
      `${topic} 생각`,
      `${topic} 철학`,
      `${topic} 윤리`,
      grade === "lower" ? "초등 철학동화" : "어린이 인문학",
      grade === "lower" ? "어린이 과학 그림책" : "초등 과학 인문학",
    ],
    8,
  );
}

async function expandInterestSearchKeywords({
  originalText,
  selectedKeyword,
  grade,
}: {
  originalText?: string;
  selectedKeyword: string;
  grade: "lower" | "higher";
}): Promise<string[]> {
  const topic = originalText?.trim() || selectedKeyword;

  if (
    !process.env.AI_INTEGRATIONS_GEMINI_BASE_URL ||
    !process.env.AI_INTEGRATIONS_GEMINI_API_KEY
  ) {
    return contextualFallbackSearchTerms(topic, selectedKeyword, grade);
  }

  const prompt = `You create Korean Kakao Book Search queries for an elementary philosophy book recommender.

Student interest: "${topic}"
Selected inquiry keyword: "${selectedKeyword}"
Grade group: ${grade === "lower" ? "grades 1-3" : "grades 4-6"}

Return 6 Korean search queries. Use a balanced mix:
- the selected keyword or close variants
- children's story/picture/science queries if the interest is concrete, such as robots or space
- ethics, relationship, thinking, philosophy, or humanities queries
- broad elementary philosophy fallback queries

Do not return book titles. Return only JSON.`;

  try {
    const text = await generateGeminiText([{ text: prompt }], 1024, true, {
      type: "OBJECT",
      properties: {
        keywords: {
          type: "ARRAY",
          minItems: 4,
          maxItems: 8,
          items: { type: "STRING" },
        },
      },
      required: ["keywords"],
    });
    const parsed = parseModelJson<{ keywords?: string[] }>(text);
    return uniqueStrings(
      [selectedKeyword, ...(parsed.keywords ?? []), ...contextualFallbackSearchTerms(topic, selectedKeyword, grade)],
      8,
    );
  } catch (error) {
    console.warn("[recommend] Gemini expanded keyword generation failed.", {
      message: error instanceof Error ? error.message : String(error),
    });
    return contextualFallbackSearchTerms(topic, selectedKeyword, grade);
  }
}

function tokenizeKoreanish(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .map((word) => word.trim())
        .filter((word) => word.length >= 2),
    ),
  );
}

function scoreBookCandidate(
  book: KakaoBook,
  context: RecommendationContext,
  grade: "lower" | "higher",
): number {
  const haystack = `${book.title} ${book.contents ?? ""} ${book.publisher ?? ""} ${book.authors.join(" ")}`.toLowerCase();
  const contents = (book.contents ?? "").toLowerCase();
  const title = book.title.toLowerCase();
  const topicWords = tokenizeKoreanish(`${context.sourceText} ${context.selectedKeyword ?? ""}`);
  const philosophyWords = [
    "철학",
    "생각",
    "질문",
    "마음",
    "관계",
    "윤리",
    "가치",
    "인문",
    "상상",
    "친구",
    "자유",
    "정의",
    "책임",
    "선택",
    "토론",
    "딜레마",
    "존재",
    "정체성",
  ];
  const childWords = ["어린이", "초등", "그림책", "동화", "청소년", "과학", "이야기", "교양"];
  const infoOnlyWords = ["백과", "도감", "사전", "원리", "실험", "공학", "코딩", "만들기", "작동", "지식", "정보"];
  const adultWords = ["대학", "논문", "전공", "수험", "투자", "주식", "자격증", "석사", "박사", "문제집", "수능"];

  let score = 0;
  let contentTopicMatches = 0;
  let philosophyMatches = 0;
  for (const word of topicWords) {
    if (title.includes(word)) score += 5;
    if (contents.includes(word)) contentTopicMatches += 1;
    if (haystack.includes(word)) score += 2;
  }
  for (const word of philosophyWords) {
    if (haystack.includes(word)) {
      philosophyMatches += 1;
      score += title.includes(word) ? 5 : 3;
    }
  }
  for (const word of childWords) if (haystack.includes(word)) score += grade === "lower" ? 2 : 1;
  for (const word of infoOnlyWords) if (haystack.includes(word)) score -= philosophyMatches > 0 ? 1 : 4;
  if (book.thumbnail) score += 2;
  if ((book.contents ?? "").trim().length > 30) score += 2;
  if (topicWords.length > 0 && contentTopicMatches === 0) score -= 8;
  if (philosophyMatches === 0) score -= 7;
  if (philosophyMatches >= 2) score += 5;
  if (/퍼플|부크크|좋은땅|북랩/.test(book.publisher ?? "")) score -= 2;
  if (grade === "lower" && /철학동화|그림책|동화|어린이|초등|생각|마음/.test(haystack)) score += 5;
  if (grade === "higher" && /인문|교양|청소년|철학|윤리|토론|생각/.test(haystack)) score += 5;
  for (const word of adultWords) if (haystack.includes(word)) score -= 6;

  return score;
}

async function fetchBalancedBooks(
  keywords: string[],
  grade: "lower" | "higher",
  context: RecommendationContext,
  log?: import("pino").Logger,
  limit = 30,
): Promise<KakaoBook[]> {
  const seen = new Set<string>();
  const combined: KakaoBook[] = [];

  const addBooks = (raw: KakaoBook[]) => {
    const filtered = filterForGrade(raw, grade);
    for (const book of filtered) {
      const key = book.isbn || book.title.replace(/\s+/g, " ").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      combined.push(book);
      if (combined.length >= limit) break;
    }
  };

  for (const keyword of keywords) {
    if (combined.length >= limit) break;
    addBooks(await searchKakaoBooks(keyword, 10, log));
  }

  if (combined.length === 0) {
    const broadFallbacks =
      grade === "lower"
        ? ["초등 철학동화", "어린이 생각 그림책", "어린이 과학 그림책"]
        : ["초등 철학", "어린이 인문학", "청소년 철학"];
    for (const keyword of broadFallbacks) {
      if (combined.length >= limit) break;
      addBooks(await searchKakaoBooks(keyword, 10, log));
    }
  }

  return combined
    .map((book, order) => ({
      book,
      order,
      score: scoreBookCandidate(book, context, grade),
    }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((entry) => entry.book)
    .slice(0, limit);
}

function buildRecommendationPayload(
  book: KakaoBook,
  aiText: Omit<AiSelection, "selectedIndex">,
  extra: {
    detectedBook?: string | null;
    selectedKeyword?: string;
    sourceInterest?: string | null;
    candidateCount?: number;
  } = {},
) {
  const philosopherName =
    aiText.philosopherName?.trim() || cleanPhilosopherName(aiText.philosophyKnowledge);
  return {
    bookId: book.isbn || book.title,
    bookTitle: book.title,
    bookAuthor: book.authors.join(", "),
    publisher: book.publisher || null,
    coverUrl: book.thumbnail || null,
    ...(extra.detectedBook !== undefined ? { detectedBook: extra.detectedBook } : {}),
    empathyMessage: aiText.empathyMessage,
    recommendationReason: aiText.recommendationReason,
    thinkingQuestion: aiText.thinkingQuestion,
    philosophyKnowledge: aiText.philosophyKnowledge ?? null,
    selectedKeyword: extra.selectedKeyword,
    sourceInterest: extra.sourceInterest,
    philosopherName,
    philosophicalLens:
      aiText.philosophicalLens?.trim() ||
      (aiText.philosophyKnowledge ? aiText.philosophyKnowledge.slice(0, 80) : null),
    candidateCount: extra.candidateCount,
  };
}

function compactText(text: string | null | undefined, maxLength = 220): string {
  return (text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function latestMessage(history: ChatMessage[], role: ChatMessage["role"]): string {
  return [...history].reverse().find((item) => item.role === role)?.content ?? "";
}

function classifyStudentQuestion(message: string): "followup" | "mindRobotHuman" | "whyHow" | "relationship" | "emotion" | "general" {
  if (/그럼|그러면|그래서|아까|방금|그렇다면/.test(message)) return "followup";
  if (/인간|사람|로봇|마음|생각|영혼|정체성/.test(message)) return "mindRobotHuman";
  if (/왜|어떻게|무엇|뭐가|무슨|기준/.test(message)) return "whyHow";
  if (/친구|관계|함께|도와|배려|책임/.test(message)) return "relationship";
  if (/화|속상|슬픔|기쁨|무서|감정|마음/.test(message)) return "emotion";
  return "general";
}

function hasSimilarWords(a: string, b: string): boolean {
  const aWords = new Set(tokenizeKoreanish(a));
  const bWords = tokenizeKoreanish(b);
  if (aWords.size === 0 || bWords.length === 0) return false;
  const shared = bWords.filter((word) => aWords.has(word)).length;
  return shared >= 2 || shared / Math.max(1, Math.min(aWords.size, bWords.length)) >= 0.45;
}

async function selectAndDescribeBalanced(
  context: RecommendationContext,
  books: KakaoBook[],
  grade: "lower" | "higher",
): Promise<{ book: KakaoBook; text: Omit<AiSelection, "selectedIndex"> }> {
  const candidateBooks = books.slice(0, 24);
  if (!hasGeminiConfig()) {
    throw new GeminiUnavailableError(geminiErrorMessage("추천 도서 설명 생성"));
  }

  const bookList = candidateBooks
    .map(
      (book, index) => `[${index}] Title: ${book.title}
Authors: ${book.authors.join(", ")}
Publisher: ${book.publisher || "(none)"}
Description: ${book.contents || "(none)"}`,
    )
    .join("\n\n");

  const prompt = `You are a careful Korean elementary philosophy book recommender.

Student original interest or feeling: "${context.sourceText}"
Selected inquiry keyword: "${context.selectedKeyword ?? "(none)"}"
Search mode: ${context.searchMode}
Grade group: ${grade === "lower" ? "grades 1-3" : "grades 4-6"}

Choose exactly one book from this real Kakao Book Search candidate list. Do not invent books.

${bookList}

Write all output fields in Korean.
Quality rules:
- Never repeat or expose an internal routing sentence such as "추천해줘" or "고른 철학 탐구 키워드".
- Choose a book that can become a philosophy conversation, not merely a fun or informational match.
- Prefer books whose title or description clearly invites questions about values, responsibility, freedom, justice, identity, mind, relationship, emotion, or existence.
- If a candidate is mainly science/information, choose it only when its description clearly supports a philosophical question.
- Recommendation reason must mention the student interest, selected keyword if present, the chosen book title/description, and one concrete philosophical connection.
- philosophyKnowledge must explicitly include either a philosopher name or a clear philosophical concept connected to a scene or idea in the chosen book.
- philosopherName must be one stable persona that fits the recommendation.
- philosophicalLens must be a short concept phrase only, such as "기술 윤리", "마음과 정체성", "관계와 책임", "감정과 자유", or "우주와 존재".
- thinkingQuestion must be an open philosophical question for the student.
- For lower grades, write simple and concrete Korean. For upper grades, use one easy concept word but stay elementary-student friendly.

Return only JSON matching the schema.`;

  try {
    const text = await generateGeminiText([{ text: prompt }], 4096, true, {
      type: "OBJECT",
      properties: {
        selectedIndex: { type: "INTEGER" },
        empathyMessage: { type: "STRING" },
        recommendationReason: { type: "STRING" },
        philosophyKnowledge: { type: "STRING" },
        thinkingQuestion: { type: "STRING" },
        philosopherName: { type: "STRING" },
        philosophicalLens: { type: "STRING" },
      },
      required: [
        "selectedIndex",
        "empathyMessage",
        "recommendationReason",
        "philosophyKnowledge",
        "thinkingQuestion",
        "philosopherName",
        "philosophicalLens",
      ],
    });
    const result = parseModelJson<AiSelection>(text);
    const idx =
      Number.isInteger(result.selectedIndex) &&
      result.selectedIndex >= 0 &&
      result.selectedIndex < candidateBooks.length
        ? result.selectedIndex
        : 0;

    return {
      book: candidateBooks[idx],
      text: {
        empathyMessage: result.empathyMessage,
        recommendationReason: result.recommendationReason,
        thinkingQuestion: result.thinkingQuestion,
        philosophyKnowledge: result.philosophyKnowledge,
        philosopherName: result.philosopherName,
        philosophicalLens: result.philosophicalLens,
      },
    };
  } catch (error) {
    console.warn("[recommend] Gemini balanced recommendation failed.", {
      message: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof GeminiUnavailableError) throw error;
    throw new GeminiUnavailableError("Gemini가 추천 도서 설명을 만들지 못했어요. Gemini API 키, 할당량, 모델 접근 권한을 확인해 주세요.", 502);
  }
}

function fallbackPhilosopherReplyContextual({
  philosopherName,
  message,
  grade,
  bookTitle,
  philosophicalLens,
  previousStudentMessage = "",
  previousPhilosopherReply = "",
  turnIndex = 0,
}: {
  philosopherName: string;
  message: string;
  grade: "lower" | "higher";
  bookTitle: string;
  philosophicalLens?: string | null;
  previousStudentMessage?: string;
  previousPhilosopherReply?: string;
  turnIndex?: number;
}): string {
  const lens = philosophicalLens || "철학 질문";
  const kind = classifyStudentQuestion(message);
  const isRepeat = hasSimilarWords(message, previousStudentMessage) || previousPhilosopherReply.includes(message.slice(0, 12));

  if (grade === "lower") {
    if (isRepeat || kind === "followup") {
      return `아까 이야기에서 한 걸음 더 가 보자. ${bookTitle} 속 친구를 떠올리면, 마음이 있다는 말은 그냥 느끼는 것뿐 아니라 누군가를 어떻게 대할지 고르는 일과도 이어져. 그래서 이번 질문은 "겉모습보다 선택이 더 중요할까?"로 바꿔 생각해 볼 수 있어.`;
    }
    if (kind === "mindRobotHuman") {
      return `마음이 있는 로봇이 바로 인간이라고 말하기는 어려워. 하지만 그 로봇이 아픔을 느끼고 친구를 걱정한다면, 우리는 함부로 물건처럼 대하면 안 돼. ${philosopherName}라면 ${lens}을 떠올리며 "어떻게 대해야 좋을까?"를 먼저 물었을 거야.`;
    }
    if (kind === "whyHow") {
      return `좋은 질문이야. ${bookTitle}에서처럼 어떤 기준을 세우면 생각이 조금 또렷해져. 나는 "친구를 다치게 하지 않는가"와 "스스로 고를 수 있는가"를 먼저 살펴보고 싶어.`;
    }
    return `${bookTitle}과 이어서 생각하면, 네 질문은 ${lens}에 닿아 있어. 철학자는 정답을 빨리 말하기보다 네가 무엇을 소중하게 보는지 살펴보게 도와줘.`;
  }

  if (isRepeat || kind === "followup") {
    return `아까 답과 같은 말로 돌아가지 않고, 이번에는 기준을 더 좁혀 보자. ${bookTitle}과 연결하면 핵심은 "마음이 있느냐"만이 아니라 그 존재가 선택하고 책임질 수 있느냐야. ${lens}라는 관점에서는 감정, 선택, 책임 중 무엇을 인간다움의 기준으로 삼을지가 갈라져.`;
  }
  if (kind === "mindRobotHuman") {
    return `${philosopherName}의 관점에서 보면, 마음이 있는 로봇이 곧바로 인간이라고 단정할 수는 없어. 다만 감정을 느끼고 관계를 맺고 자기 선택에 책임질 수 있다면, 단순한 기계와는 다르게 대해야 해. ${bookTitle}을 떠올리면 이 질문은 "인간다움의 기준은 몸일까, 마음일까, 책임일까?"로 깊어져.`;
  }
  if (kind === "whyHow") {
    return `이 질문에는 먼저 기준이 필요해. ${bookTitle}과 ${lens}을 함께 보면, 우리는 겉모습보다 선택의 이유와 책임을 따져 볼 수 있어. 예외도 있어야 해. 마음이 있다고 말하지만 남을 계속 해친다면, 우리는 그 마음을 어떻게 평가해야 할까?`;
  }
  return `${philosopherName}라면 네 질문에서 ${lens}의 기준을 먼저 찾으려 할 거야. ${bookTitle}과 이어 보면, 중요한 건 정답 하나가 아니라 어떤 이유로 그렇게 판단하는지야. 초등학생에게도 철학은 바로 이런 기준을 천천히 세워 보는 일이야.`;
}

function genericBalancedText(
  book: KakaoBook,
  grade: "lower" | "higher",
  context: RecommendationContext,
): Omit<AiSelection, "selectedIndex"> {
  const title = book.title.replace(/<[^>]+>/g, "").trim();
  const author = book.authors[0] ? `${book.authors[0]} 작가` : "이 책의 작가";
  const source = context.sourceText.trim() || context.selectedKeyword || title;
  const keyword = context.selectedKeyword?.trim();
  const description =
    (book.contents || "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "책 속 이야기를 따라가며 스스로 생각할 거리를 찾을 수 있어요";
  const haystack = `${source} ${keyword ?? ""} ${title} ${description}`;

  const lens =
    /로봇|인공지능|AI|기술/.test(haystack)
      ? {
          philosopherName: "칸트",
          philosophicalLens: "기술 윤리와 관계",
          concept: "칸트는 어떤 행동이 모두에게도 괜찮은 규칙인지 따져 보라고 했어요",
        }
      : /우주|별|행성|지구/.test(haystack)
        ? {
            philosopherName: "소크라테스",
            philosophicalLens: "우주와 존재",
            concept: "소크라테스는 큰 세계를 바라볼 때도 먼저 내가 무엇을 아는지 묻는 일이 중요하다고 보았어요",
          }
        : /친구|관계|마음/.test(haystack)
          ? {
              philosopherName: "공자",
              philosophicalLens: "관계와 배려",
              concept: "공자는 사람다운 삶이 서로를 살피고 배려하는 관계 속에서 자란다고 보았어요",
            }
          : /화|분노|속상|감정/.test(haystack)
            ? {
                philosopherName: "스피노자",
                philosophicalLens: "감정과 자유",
                concept: "스피노자는 감정의 까닭을 이해하면 그 감정에 덜 끌려다닐 수 있다고 생각했어요",
              }
            : {
                philosopherName: "소크라테스",
                philosophicalLens: "질문과 생각",
                concept: "소크라테스는 정답을 빨리 말하기보다 왜 그렇게 생각하는지 묻는 일을 좋아했어요",
              };

  const keywordPhrase = keyword ? `, 특히 "${keyword}"라는 탐구 키워드` : "";
  const easyEnding =
    grade === "lower"
      ? "친구가 읽기에도 장면을 따라가며 생각하기 좋아요"
      : "책의 장면을 근거로 자기 생각을 더 분명하게 다듬기 좋아요";

  return {
    empathyMessage: `${source}에 마음이 갔다는 건, 세상을 그냥 지나치지 않고 더 알고 싶어 한다는 뜻이에요. 그 궁금함은 아주 좋은 철학의 시작이에요.`,
    recommendationReason: `${source}${keywordPhrase}와 연결해서는 《${title}》이 잘 맞아요. ${author}의 이 책은 "${description}" 같은 내용을 바탕으로, ${lens.philosophicalLens}라는 생각 렌즈를 자연스럽게 떠올리게 해요. 그래서 단순히 주제를 아는 데서 끝나지 않고 ${easyEnding}.`,
    philosophyKnowledge: `${lens.concept}. 《${title}》을 읽을 때도 책 속 인물이나 장면을 보며 "이 선택은 누구에게 도움이 될까?", "다르게 생각하면 무엇이 달라질까?"처럼 물어볼 수 있어요. 그런 질문이 이 책을 작은 철학 대화로 바꾸어 줍니다.`,
    thinkingQuestion: `${source}에 대해 생각할 때, 나는 무엇을 가장 소중하게 지키고 싶나요? 그리고 그 생각은 다른 사람에게도 괜찮은 기준이 될까요?`,
    philosopherName: lens.philosopherName,
    philosophicalLens: lens.philosophicalLens,
  };
}

async function chatWithPhilosopherBalanced({
  message,
  history = [],
  grade,
  bookTitle,
  bookAuthor,
  philosophyKnowledge,
  recommendationReason,
  thinkingQuestion,
  philosopherName,
  philosophicalLens,
}: {
  message: string;
  history?: ChatMessage[];
  grade: "lower" | "higher";
  bookTitle: string;
  bookAuthor?: string;
  philosophyKnowledge?: string | null;
  recommendationReason?: string;
  thinkingQuestion?: string;
  philosopherName?: string | null;
  philosophicalLens?: string | null;
}): Promise<{ philosopherName: string; reply: string }> {
  const personaName =
    philosopherName?.trim() ||
    cleanPhilosopherName(`${philosophicalLens ?? ""} ${philosophyKnowledge ?? ""}`);
  const previousStudentMessage = latestMessage(history, "student");
  const previousPhilosopherReply = latestMessage(history, "philosopher");
  const questionType = classifyStudentQuestion(message);
  const repeatedQuestion = hasSimilarWords(message, previousStudentMessage);

  if (!hasGeminiConfig()) {
    throw new GeminiUnavailableError(geminiErrorMessage("철학자와 대화하기"));
  }

  const historyText = history
    .slice(-10)
    .map((item) => `${item.role === "student" ? "Student" : personaName}: ${item.content}`)
    .join("\n");
  const previousReplies = history
    .filter((item) => item.role === "philosopher")
    .slice(-3)
    .map((item) => item.content)
    .join("\n---\n");

  const prompt = `You are ${personaName}, speaking warmly with a Korean elementary student.

Answer in Korean.

Book context:
- Title: ${bookTitle}
- Author: ${bookAuthor || "(unknown)"}
- Recommendation reason: ${recommendationReason || "(none)"}
- Philosophy knowledge shown to student: ${philosophyKnowledge || "(none)"}
- Philosophical lens: ${philosophicalLens || "(none)"}
- Seed question: ${thinkingQuestion || "(none)"}

Recent conversation:
${historyText || "(none)"}

Recent philosopher replies to avoid repeating:
${previousReplies || "(none)"}

Student's latest message:
${message}

Conversation analysis:
- Latest question type: ${questionType}
- Similar to previous student message: ${repeatedQuestion ? "yes" : "no"}
- Previous student message: ${compactText(previousStudentMessage) || "(none)"}
- Previous philosopher reply summary: ${compactText(previousPhilosopherReply) || "(none)"}

Rules:
- First answer the student's latest message directly in the first sentence.
- If the latest question is similar to the previous one, explicitly extend the idea instead of repeating the same answer.
- Do not reuse the previous reply's opening, sentence structure, final question, or conclusion.
- Connect to the book and philosophical lens only where it fits the student's actual question.
- Stay in the persona of ${personaName}, but do not overact or lecture.
- Ask at most one short follow-up question, and only if it is different from previous replies.
- ${grade === "lower"
    ? "For grades 1-3: use 2-3 short sentences, everyday examples like friends/classroom/home, no hard terms unless immediately explained."
    : "For grades 4-6: use 3-5 clear sentences, include one easy concept word such as 기준/책임/정체성/관계 and explain it simply."}
- Always remember the student is in elementary school. Never sound like a university lecture.
- Return only JSON.`;

  try {
    const text = await generateGeminiText([{ text: prompt }], 1200, true, {
      type: "OBJECT",
      properties: {
        philosopherName: { type: "STRING" },
        reply: { type: "STRING" },
      },
      required: ["philosopherName", "reply"],
    });
    const parsed = parseModelJson<{ philosopherName?: string; reply?: string }>(text);
    return {
      philosopherName: parsed.philosopherName?.trim() || personaName,
      reply:
        parsed.reply?.trim() ||
        fallbackPhilosopherReplyContextual({
          philosopherName: personaName,
          message,
          grade,
          bookTitle,
          philosophicalLens,
          previousStudentMessage,
          previousPhilosopherReply,
          turnIndex: history.length,
        }),
    };
  } catch (error) {
    console.warn("[recommend] Gemini balanced philosopher chat failed.", {
      message: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof GeminiUnavailableError) throw error;
    throw new GeminiUnavailableError("Gemini가 철학자 답변을 만들지 못했어요. API 키, 할당량, 모델 접근 권한을 확인해 주세요.", 502);
  }
}

// ──────────────────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────────────────
router.post("/recommend/interest-keywords", async (req, res): Promise<void> => {
  const parsed = GenerateInterestKeywordsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const keywords = await generateInterestKeywordOptions(parsed.data.text);
    res.json({ keywords, aiSource: "gemini" });
  } catch (error) {
    if (sendGeminiError(res, error)) return;
    throw error;
  }
});

router.post("/recommend/by-keyword", async (req, res): Promise<void> => {
  const parsed = RecommendByKeywordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { keyword, originalText, gradeGroup } = parsed.data;
  const grade = gradeGroup === "lower" ? "lower" : "higher";
  const context: RecommendationContext = {
    sourceText: originalText?.trim() || keyword,
    selectedKeyword: keyword,
    searchMode: "interest",
  };
  const searchKeywords = await expandInterestSearchKeywords({
    originalText,
    selectedKeyword: keyword,
    grade,
  });
  const books = await fetchBalancedBooks(searchKeywords, grade, context, req.log, 30);

  if (books.length === 0) {
    res.status(503).json({
      error:
        "지금 선택한 키워드로 책을 찾을 수 없어요. 다른 탐구 키워드를 골라 볼래요?",
    });
    return;
  }

  let selected;
  try {
    selected = await selectAndDescribeBalanced(context, books, grade);
  } catch (error) {
    if (sendGeminiError(res, error)) return;
    throw error;
  }
  const { book, text: aiText } = selected;

  res.json(
    {
      ...buildRecommendationPayload(book, aiText, {
      selectedKeyword: keyword,
      sourceInterest: originalText ?? null,
      candidateCount: books.length,
      }),
      aiSource: "gemini",
    },
  );
});

router.post("/recommend/philosopher-chat", async (req, res): Promise<void> => {
  const parsed = ChatWithPhilosopherBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const {
    message,
    history,
    gradeGroup,
    bookTitle,
    bookAuthor,
    philosophyKnowledge,
    recommendationReason,
    thinkingQuestion,
    philosopherName,
    philosophicalLens,
  } = parsed.data;
  const grade = gradeGroup === "lower" ? "lower" : "higher";
  let reply;
  try {
    reply = await chatWithPhilosopherBalanced({
      message,
      history,
      grade,
      bookTitle,
      bookAuthor,
      philosophyKnowledge,
      recommendationReason,
      thinkingQuestion,
      philosopherName,
      philosophicalLens,
    });
  } catch (error) {
    if (sendGeminiError(res, error)) return;
    throw error;
  }

  res.json({ ...reply, aiSource: "gemini" });
});

router.post("/recommend/by-text", async (req, res): Promise<void> => {
  const parsed = RecommendByTextBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { text, gradeGroup, searchType } = parsed.data;
  const grade = gradeGroup === "lower" ? "lower" : "higher";
  const mode: "emotion" | "interest" = searchType === "interest" ? "interest" : "emotion";

  // STEP 1: AI generates search keywords (not books)
  const keywords = await generateSearchKeywords(text, grade, mode);

  // STEP 2: Fetch real books from Kakao API (grade-filtered)
  const context: RecommendationContext = {
    sourceText: text,
    selectedKeyword: keywords[0],
    searchMode: mode,
  };
  const books = await fetchBalancedBooks(keywords, grade, context, req.log, 24);

  if (books.length === 0) {
    res.status(503).json({
      error:
        "지금 책을 찾을 수 없어요. 잠시 후 다시 시도해 줄래요? 도서 검색 서비스에 일시적인 문제가 있어요. 😥",
    });
    return;
  }

  // STEP 3: AI picks the best book from the real results + writes text
  let selected;
  try {
    selected = await selectAndDescribeBalanced(context, books, grade);
  } catch (error) {
    if (sendGeminiError(res, error)) return;
    throw error;
  }
  const { book, text: aiText } = selected;

  res.json(
    {
      ...buildRecommendationPayload(book, aiText, {
        selectedKeyword: mode === "interest" ? keywords[0] : undefined,
        sourceInterest: mode === "interest" ? text : undefined,
        candidateCount: books.length,
      }),
      aiSource: "gemini",
    },
  );
});

router.post("/recommend/by-image", async (req, res): Promise<void> => {
  const parsed = RecommendByImageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { imageBase64, mimeType, fallbackTitle, gradeGroup } = parsed.data;
  const grade = gradeGroup === "lower" ? "lower" : "higher";
  const gradeLabel = grade === "lower" ? "초등 저학년" : "초등 고학년";

  // STEP 1: Detect book title from the uploaded image
  let detectedBook: string | null = fallbackTitle ?? null;
  if (
    !detectedBook &&
    process.env.AI_INTEGRATIONS_GEMINI_BASE_URL &&
    process.env.AI_INTEGRATIONS_GEMINI_API_KEY
  ) {
    const ai = await getGeminiAi();
    try {
      if (!ai) throw new Error("Gemini AI integration unavailable");
      const detectResponse = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: mimeType ?? "image/jpeg", data: imageBase64 } },
              {
                text: `이 책 표지 이미지에서 책 제목을 파악해주세요. 
책 제목만 텍스트로 답하세요. 제목을 파악할 수 없으면 "알 수 없음"이라고만 답하세요.`,
              },
            ],
          },
        ],
        config: { maxOutputTokens: 100 },
      });
      const detected = (detectResponse.text ?? "").trim();
      detectedBook = detected === "알 수 없음" ? null : detected;
    } catch (err) {
      req.log.warn({ err }, "Image book detection failed");
    }
  }

  // STEP 2: Generate search keywords for a follow-up philosophy book
  const followUpLabel = grade === "lower" ? "철학 그림책" : "철학 인문학";
  const searchContext = detectedBook
    ? `학생이 "${detectedBook}"이라는 책을 읽었다. 이 책과 연결되는 ${gradeLabel} ${followUpLabel}을 찾아줘.`
    : `${gradeLabel} 학생에게 맞는 ${followUpLabel}을 찾아줘.`;

  const keywords = await generateSearchKeywords(searchContext, grade);

  // If we have a detected book, prepend grade-appropriate keyword variant
  const fallbackKw = grade === "lower" ? "초등 철학동화" : "초등 철학";
  const allKeywords = detectedBook
    ? [`${gradeLabel} ${keywords[0] ?? fallbackKw}`, keywords[1] ?? fallbackKw]
    : keywords;

  // STEP 3: Fetch real books from Kakao (grade-filtered)
  const imageContext: RecommendationContext = {
    sourceText: detectedBook || "책 표지",
    selectedKeyword: allKeywords[0],
    searchMode: "image",
  };
  const books = await fetchBalancedBooks(allKeywords, grade, imageContext, req.log, 24);

  if (books.length === 0) {
    res.status(503).json({
      error:
        "지금 책을 찾을 수 없어요. 잠시 후 다시 시도해 줄래요? 도서 검색 서비스에 일시적인 문제가 있어요. 😥",
    });
    return;
  }

  // STEP 4: AI picks best book + writes text
  let selected;
  try {
    selected = await selectAndDescribeBalanced(imageContext, books, grade);
  } catch (error) {
    if (sendGeminiError(res, error)) return;
    throw error;
  }
  const { book, text: aiText } = selected;

  res.json(
    {
      ...buildRecommendationPayload(book, aiText, {
        detectedBook,
        selectedKeyword: allKeywords[0],
        sourceInterest: detectedBook,
        candidateCount: books.length,
      }),
      aiSource: "gemini",
    },
  );
});

export default router;
