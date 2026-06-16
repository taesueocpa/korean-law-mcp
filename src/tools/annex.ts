/**
 * get_annexes Tool - 별표/서식 조회 + 텍스트 추출
 */

import { z } from "zod"
import type { LawApiClient } from "../lib/api-client.js"
import { fetchWithRetry } from "../lib/fetch-with-retry.js"
import { parseAnnexFile } from "../lib/annex-file-parser.js"
import { truncateResponse, MAX_RESPONSE_SIZE } from "../lib/schemas.js"
import { formatToolError, notFoundResponse } from "../lib/errors.js"
import { getLawSiteBaseUrl } from "../lib/law-url-config.js"

/** 법제처 별표/서식 API 응답 개별 항목 */
interface AnnexItem {
  별표일련번호?: string
  별표번호?: string
  별표명?: string
  별표종류?: string
  별표서식파일링크?: string
  별표서식PDF파일링크?: string
  별표파일링크?: string
  관련법령명?: string
  관련법령ID?: string
  관련자치법규명?: string
  관련행정규칙명?: string
  관련행정규칙일련번호?: string
  관련행정규칙ID?: string
  자치법규시행일자?: string
  공포일자?: string
  발령일자?: string
  소관부처?: string
  소관부처명?: string
  지자체기관명?: string
}

const LAW_BASE_URL = getLawSiteBaseUrl()

export const GetAnnexesSchema = z.object({
  lawName: z.string().describe("법령명/행정규칙명 (예: '관세법', '외부감사 및 회계 등에 관한 규정 시행세칙'). 별표를 바로 지정하려면 '... 별표4'처럼 함께 입력 가능"),
  knd: z.enum(["1", "2", "3", "4", "5"]).optional().describe("1=별표, 2=서식, 3=부칙별표, 4=부칙서식, 5=전체"),
  bylSeq: z.string().optional().describe("별표번호 (예: '000300'). 지정 시 해당 별표 파일을 다운로드하여 텍스트로 추출"),
  annexNo: z.string().optional().describe("별표 번호 (예: '4', '별표4', '제4호'). bylSeq 대체 입력"),
  adminRuleId: z.string().optional().describe("행정규칙일련번호 또는 행정규칙ID ('admrul:' 프리픽스 허용). 지정 시 행정규칙(admbyl) 별표 경로로 조회. lawName에 'admrul:...' 또는 순수 숫자 ID를 넣어도 자동 인식"),
  apiKey: z.string().optional().describe("법제처 Open API 인증키(OC). 사용자가 제공한 경우 전달")
})

export type GetAnnexesInput = z.infer<typeof GetAnnexesSchema>

// 법제처 API는 결과 1건일 때 배열 대신 단일 객체를 반환하므로 정규화
function toArray(v: unknown): AnnexItem[] {
  return v == null ? [] : Array.isArray(v) ? v : [v]
}

/** 별표/서식 검색 응답(JSON) 파싱 — 법령(licbyl)·자치법규(ordinbyl)·행정규칙(admrulbyl) 공용 */
function parseAnnexResponse(jsonText: string): { list: AnnexItem[], type: string } {
  try {
    const json = JSON.parse(jsonText)
    const adminResult = json?.admRulBylSearch
    const licResult = json?.licBylSearch
    // 행정규칙 별표 항목 키는 admrulbyl (구버전/문서상 admbyl 표기도 방어적으로 허용)
    const adminItems = adminResult?.admrulbyl ?? adminResult?.admbyl
    if (adminItems) return { list: toArray(adminItems), type: "admin" }
    if (licResult?.ordinbyl) return { list: toArray(licResult.ordinbyl), type: "ordinance" }
    if (licResult?.licbyl) return { list: toArray(licResult.licbyl), type: "law" }
    return { list: [], type: "law" }
  } catch {
    // JSON 파싱 실패 (HTML 에러 페이지 등) → 빈 배열 반환하여 fallback 진행
    return { list: [], type: "law" }
  }
}

export async function getAnnexes(
  apiClient: LawApiClient,
  input: GetAnnexesInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  try {
    const parsedLawInput = parseLawNameAndHint(input.lawName)
    const normalizedLawName = parsedLawInput.normalizedLawName || input.lawName
    const annexSelector = (input.bylSeq || input.annexNo || parsedLawInput.annexNo || "").trim()
    // 동일 번호(별표/별지/서식) 충돌 시 선택 우선순위 — 입력 힌트(별표6/서식6) > knd
    const preferredAnnexType = parsedLawInput.annexType ?? annexTypeFromKnd(input.knd)

    // 행정규칙 ID(adminRuleId 또는 lawName 내 admrul:/순수 숫자)가 인식되면 admbyl 경로로 분기.
    // 법령 별표 경로는 그대로 유지 (adminRuleId 미인식 시 아래 기존 로직 100% 동일).
    const adminRuleId = resolveAdminRuleId(input)
    if (adminRuleId) {
      return await extractAdminRuleAnnexes(apiClient, {
        adminRuleId,
        normalizedLawName,
        annexSelector,
        preferredType: preferredAnnexType,
        apiKey: input.apiKey,
        input,
      })
    }

    let annexList: AnnexItem[] = []
    let lawType: string = "law"

    // 1차: 원래 법령명 + knd 필터
    const result1 = parseAnnexResponse(await apiClient.getAnnexes({
      lawName: normalizedLawName, knd: input.knd, apiKey: input.apiKey
    }))
    annexList = result1.list
    lawType = result1.type

    // 2차: 결과 없으면 knd 제거 (법제처가 "별표"를 "서식"으로 분류하는 경우)
    if (annexList.length === 0 && input.knd) {
      const result2 = parseAnnexResponse(await apiClient.getAnnexes({
        lawName: normalizedLawName, apiKey: input.apiKey
      }))
      annexList = result2.list
      lawType = result2.type
    }

    // 3차: 모법명으로 재검색 ("여권법 시행규칙" → "여권법")
    if (annexList.length === 0) {
      const parentName = extractParentLawName(normalizedLawName)
      if (parentName) {
        const result3 = parseAnnexResponse(await apiClient.getAnnexes({
          lawName: parentName, apiKey: input.apiKey
        }))
        // 원래 법령명 매칭 필터
        const filtered = result3.list.filter((a: AnnexItem) => {
          const name = String(a.관련법령명 || a.관련자치법규명 || a.관련행정규칙명 || "").replace(/<[^>]+>/g, "")
          return name === normalizedLawName
        })
        annexList = filtered.length > 0 ? filtered : result3.list
        lawType = result3.type
      }
    }

    // 4차: "규정" 타입은 licbyl과 admbyl 양쪽에 존재 가능 → admin fallback
    if (annexList.length === 0 && /규정/.test(normalizedLawName)) {
      try {
        const adminText = await apiClient.fetchApi({
          endpoint: "lawSearch.do",
          target: "admbyl",
          type: "JSON",
          extraParams: {
            query: normalizedLawName,
            search: "2",
            display: "100",
          },
          apiKey: input.apiKey,
        })
        const result4 = parseAnnexResponse(adminText)
        if (result4.list.length > 0) {
          annexList = result4.list
          lawType = "admin"
        }
      } catch {
        // admin fallback 실패 → 무시하고 진행
      }
    }

    if (annexList.length === 0) {
      return notFoundResponse(
        `"${normalizedLawName}"에 대한 별표/서식이 법제처 DB에 없습니다.`,
        [
          "법령명 오탈자 확인 (예: '관세법 시행령' vs '관세법')",
          `search_law({ query: "${normalizedLawName}" }) 로 정확한 법령명 확인`,
          "모법에 별표가 있을 수 있음 (시행규칙 대신 시행령으로 재시도)",
        ]
      )
    }

    // 최신본 우선 정렬
    annexList.sort((a: AnnexItem, b: AnnexItem) =>
      (b.자치법규시행일자 || b.공포일자 || "").localeCompare(a.자치법규시행일자 || a.공포일자 || "")
    )

    // 관련법규명 필터링: 사용자 쿼리와 가장 일치하는 조례 우선
    const filtered = filterByRelatedLawName(annexList, normalizedLawName)

    // 별표 선택값 지정 시 → 해당 별표 파일 다운로드 + 텍스트 추출
    if (annexSelector) {
      return await extractAnnexContent(filtered, annexSelector, normalizedLawName, preferredAnnexType)
    }

    // 별표 선택값 미지정 → 기존 목록 반환
    return formatAnnexList(filtered, lawType, input, normalizedLawName)
  } catch (error) {
    return formatToolError(error, "get_annexes")
  }
}

// ─── 별표 텍스트 추출 ─────────────────────────────────

async function extractAnnexContent(
  annexList: AnnexItem[],
  annexSelector: string,
  normalizedLawName: string,
  preferredType?: AnnexKind
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  // bylSeq / annexNo / lawName 내 힌트로 유연 매칭
  const matched = findMatchingAnnex(annexList, annexSelector, preferredType)
  if (!matched) {
    const availableBylSeq = annexList.map((a) => a.별표번호).filter(Boolean).slice(0, 20).join(", ")
    return notFoundResponse(
      `별표 선택값 "${annexSelector}"에 해당하는 항목을 찾을 수 없습니다. (법령: ${normalizedLawName})`,
      [
        `사용 가능한 별표번호(일부): ${availableBylSeq || "없음"}`,
        `예: get_annexes({ lawName: "${normalizedLawName}", bylSeq: "${annexList[0]?.별표번호 || "000100"}" })`,
        `예: get_annexes({ lawName: "${normalizedLawName} 별표4" })`,
      ]
    )
  }

  const annexTitle = matched.별표명 || "제목 없음"
  const fileLink = matched.별표서식파일링크 || matched.별표서식PDF파일링크 || matched.별표파일링크 || ""

  if (!fileLink) {
    return notFoundResponse(
      `"${annexTitle}"의 파일 링크가 법제처 응답에 포함되지 않았습니다.`,
      ["법령 전체 별표 목록을 다시 조회하세요: get_annexes({ lawName: '...' })"]
    )
  }

  // 파일 다운로드
  const downloadUrl = `${LAW_BASE_URL}${fileLink}`
  const response = await fetchWithRetry(downloadUrl, { timeout: 30000 })
  if (!response.ok) {
    return {
      content: [{ type: "text", text: `파일 다운로드 실패: HTTP ${response.status}\nURL: ${downloadUrl}` }],
      isError: true
    }
  }

  const buffer = await response.arrayBuffer()
  const result = await parseAnnexFile(buffer)

  if (result.fileType === "pdf" && result.isImageBased) {
    // 이미지 기반 PDF: 텍스트 추출 불가 → 링크 안내
    const pdfLink = matched.별표서식PDF파일링크 || fileLink
    return {
      content: [{
        type: "text",
        text: `${annexTitle}\n\n이미지 기반 PDF입니다 (${result.pageCount || "?"}페이지). 텍스트 추출이 불가합니다.\n다운로드 링크: ${LAW_BASE_URL}${pdfLink}`
      }]
    }
  }

  if (!result.success || !result.markdown) {
    // 파싱 실패 시에도 PDF 링크 안내
    const fallbackLink = matched.별표서식PDF파일링크 || fileLink
    return {
      content: [{
        type: "text",
        text: `"${annexTitle}" 텍스트 추출 실패: ${result.error || "알 수 없는 오류"}\n파일 링크: ${LAW_BASE_URL}${fallbackLink}`
      }],
      isError: true
    }
  }

  // 파싱 성공 - 묶음 별표면 요청 섹션만 추출
  let markdown = result.markdown
  const selectorNumbers = extractSelectorNumbers(annexSelector)
  if (selectorNumbers.length > 0 && isBundledAnnex(annexTitle)) {
    const extracted = extractBundledSection(markdown, selectorNumbers[0])
    if (extracted) markdown = extracted
  }

  const header = `${normalizedLawName} - ${annexTitle}\n(파일 형식: ${result.fileType.toUpperCase()}${result.pageCount ? `, ${result.pageCount}페이지` : ""})\n\n`
  const fullText = header + markdown
  return {
    content: [{
      type: "text",
      text: truncateResponse(fullText, MAX_RESPONSE_SIZE)
    }]
  }
}

// ─── 행정규칙 별표 (admbyl) ───────────────────────────

/**
 * 입력에서 행정규칙 ID 해석.
 * - adminRuleId 직접 제공: 'admrul:' 프리픽스 제거 후 사용
 * - lawName 내 'admrul:<숫자>' 또는 lawName 전체가 순수 숫자(6자리+)면 ID로 승격
 * 그 외(일반 법령명)는 null → 기존 법령 별표 경로 유지
 */
function resolveAdminRuleId(input: GetAnnexesInput): string | null {
  const strip = (v: string) => v.replace(/^\s*admrul:\s*/i, "").trim()

  if (input.adminRuleId && input.adminRuleId.trim()) {
    return strip(input.adminRuleId) || null
  }

  const name = (input.lawName || "").trim()
  const prefixed = name.match(/admrul:\s*(\d{4,})/i)
  if (prefixed) return prefixed[1]
  if (/^\d{6,}$/.test(name)) return name
  return null
}

/** 행정규칙 본문 응답(XML/JSON)에서 행정규칙명 추출 */
function extractRuleNameFromResponse(text: string): string | null {
  const json = text.match(/"행정규칙명"\s*:\s*"([^"]+)"/)
  if (json) return json[1].replace(/<[^>]+>/g, "").trim() || null
  const xml = text.match(/<행정규칙명>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/행정규칙명>/)
  if (xml) return xml[1].replace(/<[^>]+>/g, "").trim() || null
  return null
}

/**
 * 별표 항목이 주어진 행정규칙 ID와 매칭되는지 판별.
 * 법제처가 일련번호/ID/관련법령ID 중 어느 필드로 내려줄지 변형 가능성이 있어
 * 후보 필드를 모두 비교하고, 선행 0 패딩 차이도 허용한다.
 */
function annexMatchesAdminRuleId(item: AnnexItem, ruleId: string): boolean {
  const target = ruleId.replace(/^0+/, "")
  const candidates = [item.관련행정규칙일련번호, item.관련행정규칙ID, item.관련법령ID]
  return candidates.some((c) => {
    const v = String(c ?? "").trim()
    return v !== "" && (v === ruleId || v.replace(/^0+/, "") === target)
  })
}

/** 한글이 포함되어 실제 명칭으로 볼 수 있는지 (순수 숫자 ID와 구분) */
function looksLikeRuleName(value: string): boolean {
  return /[가-힣]/.test(value)
}

/**
 * 행정규칙 별표/서식 조회 (target=admbyl).
 * 법령 별표 흐름의 extractAnnexContent/formatAnnexList/findMatchingAnnex를 그대로 재사용한다.
 */
async function extractAdminRuleAnnexes(
  apiClient: LawApiClient,
  opts: {
    adminRuleId: string
    normalizedLawName: string
    annexSelector: string
    preferredType?: AnnexKind
    apiKey?: string
    input: GetAnnexesInput
  }
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  const { adminRuleId, normalizedLawName, annexSelector, preferredType, apiKey, input } = opts

  // 1. 행정규칙명 확보: lawName이 실제 명칭이면 그대로, 아니면 ID로 본문 조회해 명칭 해석
  let ruleName = looksLikeRuleName(normalizedLawName) ? normalizedLawName : ""
  if (!ruleName) {
    try {
      const ruleText = await apiClient.getAdminRule(adminRuleId, apiKey)
      ruleName = extractRuleNameFromResponse(ruleText) || ""
    } catch {
      // 명칭 해석 실패 → 아래에서 ID를 query로 직접 시도
    }
  }

  // 2. admbyl 조회 (행정규칙명 우선, 없으면 ID로 직접 검색)
  const query = ruleName || adminRuleId
  let { list } = parseAnnexResponse(
    await apiClient.getAdminRuleAnnexes({ query, search: "2", apiKey })
  )

  // 3. 해당규칙(search=2) 검색이 비면 별표서식명(search=1)으로 재시도
  if (list.length === 0 && ruleName) {
    const retry = parseAnnexResponse(
      await apiClient.getAdminRuleAnnexes({ query: ruleName, search: "1", apiKey })
    )
    list = retry.list
  }

  if (list.length === 0) {
    return notFoundResponse(
      `행정규칙 ID "${adminRuleId}"${ruleName ? ` (${ruleName})` : ""}에 대한 별표/서식을 법제처(admbyl)에서 찾지 못했습니다.`,
      [
        "search_admin_rule 로 정확한 행정규칙명/일련번호를 먼저 확인하세요.",
        '행정규칙명으로 직접 조회: get_annexes({ lawName: "<행정규칙명>" })',
      ]
    )
  }

  // 4. 동일 ID 항목으로 정밀 필터 (필드 변형에 견고). 0건이면 명칭 기반 narrowing 폴백.
  const byId = list.filter((a) => annexMatchesAdminRuleId(a, adminRuleId))
  let filtered = byId.length > 0 ? byId : list
  if (byId.length === 0 && ruleName) {
    filtered = filterByRelatedLawName(filtered, ruleName)
  }

  // 5. 최신본 우선 정렬 (발령일자/공포일자)
  filtered.sort((a, b) =>
    (b.발령일자 || b.공포일자 || "").localeCompare(a.발령일자 || a.공포일자 || "")
  )

  const displayName = ruleName || normalizedLawName

  // 6. 별표 선택값 지정 시 → 파일 다운로드 + 텍스트 추출, 미지정 시 목록
  if (annexSelector) {
    return await extractAnnexContent(filtered, annexSelector, displayName, preferredType)
  }
  return formatAnnexList(filtered, "admin", input, displayName)
}

// ─── 목록 포맷 (기존 동작) ────────────────────────────

function formatAnnexList(
  annexList: AnnexItem[],
  lawType: string,
  input: GetAnnexesInput,
  normalizedLawName: string
): { content: Array<{ type: string, text: string }> } {
  const kndLabel = input.knd === "1" ? "별표"
                 : input.knd === "2" ? "서식"
                 : input.knd === "3" ? "부칙별표"
                 : input.knd === "4" ? "부칙서식"
                 : "별표/서식"

  let resultText = `법령명: ${normalizedLawName}\n`
  resultText += `${kndLabel} 목록 (총 ${annexList.length}건):\n\n`

  const maxItems = Math.min(annexList.length, 20)

  for (let i = 0; i < maxItems; i++) {
    const annex = annexList[i]
    const annexTitle = annex.별표명 || "제목 없음"
    const annexType = annex.별표종류 || ""
    const annexNum = annex.별표번호 || ""

    resultText += `${i + 1}. `
    if (annexNum) resultText += `[${annexNum}] `
    resultText += `${annexTitle}`
    if (annexType) resultText += ` (${annexType})`
    resultText += `\n`

    if (lawType === "ordinance") {
      const relatedLaw = annex.관련자치법규명
      const localGov = annex.지자체기관명
      if (relatedLaw) {
        resultText += `   관련법규: ${relatedLaw.replace(/<[^>]+>/g, '')}\n`
      }
      if (localGov) {
        resultText += `   지자체: ${localGov}\n`
      }
    } else if (lawType === "admin") {
      if (annex.관련행정규칙명) resultText += `   행정규칙: ${String(annex.관련행정규칙명).replace(/<[^>]+>/g, '')}\n`
      const org = annex.소관부처명 || annex.소관부처
      if (org) resultText += `   소관부처: ${org}\n`
    } else {
      if (annex.관련법령명) resultText += `   관련법령: ${annex.관련법령명}\n`
    }

    resultText += `\n`
  }

  if (annexList.length > maxItems) {
    resultText += `\n... 외 ${annexList.length - maxItems}개 항목 (생략)\n`
  }

  resultText += `\n[주의] 별표 내용을 확인하려면 이 도구(get_annexes)를 bylSeq 파라미터와 함께 다시 호출하세요.\n예: get_annexes({ lawName: "${normalizedLawName}", bylSeq: "${annexList[0]?.별표번호 || '000100'}" })`
  resultText += `\n커넥터에서 bylSeq 입력이 제한되면 lawName에 별표번호를 함께 넣어 호출할 수 있습니다.\n예: get_annexes({ lawName: "${normalizedLawName} 별표4" })`

  return { content: [{ type: "text", text: truncateResponse(resultText) }] }
}

/**
 * 모법명 추출 (시행규칙/시행령 제거)
 * "여권법 시행규칙" → "여권법", "관세법 시행령" → "관세법"
 */
function extractParentLawName(lawName: string): string | null {
  const cleaned = lawName.replace(/\s*(시행규칙|시행령)$/, '')
  return cleaned !== lawName ? cleaned : null
}

/** 별표 종류 힌트 (별표/별지/서식) — 동일 번호 충돌 시 선택 우선순위에 사용 */
type AnnexKind = "별표" | "별지" | "서식"

function parseLawNameAndHint(lawName: string): { normalizedLawName: string, annexNo?: string, annexType?: AnnexKind } {
  const trimmedLawName = lawName.trim()
  const annexHintMatch = trimmedLawName.match(/\[?\s*(별표|별지|서식)\s*(?:제)?\s*(\d{1,6})\s*(?:호)?\s*\]?/)

  if (!annexHintMatch) {
    return { normalizedLawName: trimmedLawName }
  }

  const parsedAnnexNo = Number.parseInt(annexHintMatch[2], 10)
  const normalizedLawName = trimmedLawName
    .replace(annexHintMatch[0], " ")
    .replace(/\s+/g, " ")
    .trim()

  return {
    normalizedLawName: normalizedLawName || trimmedLawName,
    annexNo: Number.isNaN(parsedAnnexNo) ? undefined : String(parsedAnnexNo),
    annexType: annexHintMatch[1] as AnnexKind
  }
}

/** knd 코드(1/3=별표, 2/4=서식)에서 별표 종류 추론 */
function annexTypeFromKnd(knd?: string): AnnexKind | undefined {
  if (knd === "1" || knd === "3") return "별표"
  if (knd === "2" || knd === "4") return "서식"
  return undefined
}

/**
 * 선택값에 맞는 별표 항목 반환.
 * 행정규칙은 동일 별표번호가 별표/별지/서식에 병존(예: 별표 6 "내부회계관리제도 평가 및 보고 기준" vs
 * 별지 6 "투명성보고서")하므로, 번호가 같은 후보가 여럿이면 종류 우선순위로 선택한다.
 */
function findMatchingAnnex(annexList: AnnexItem[], annexSelector: string, preferredType?: AnnexKind): AnnexItem | undefined {
  const selectorCandidates = buildSelectorCandidates(annexSelector)
  const selectorNumbers = extractSelectorNumbers(annexSelector)

  const matches = annexList.filter((annex: AnnexItem) => {
    const annexNum = String(annex.별표번호 || "").trim()
    const annexTitle = String(annex.별표명 || "")

    if (annexNum && selectorCandidates.has(annexNum)) {
      return true
    }

    return selectorNumbers.some((num) => titleMatchesAnnexNumber(annexTitle, num))
  })

  if (matches.length <= 1) return matches[0]

  // 종류 우선순위: 요청 종류 일치(별표/별지/서식) > 별표 > 서식 > 별지. 동순위는 원래 순서 유지.
  // 힌트가 없으면 별표를 우선하되, 'lawName ... 별지N'으로 명시하면 별지도 선택 가능.
  const rank = (kind?: string): number => {
    const s = String(kind || "")
    if (preferredType && s.startsWith(preferredType)) return 0
    if (s.startsWith("별표")) return 1
    if (s.startsWith("서식")) return 2
    return 3
  }
  return [...matches].sort((a, b) => rank(a.별표종류) - rank(b.별표종류))[0]
}

function buildSelectorCandidates(selector: string): Set<string> {
  const candidates = new Set<string>()
  const trimmed = selector.trim()

  if (!trimmed) {
    return candidates
  }

  candidates.add(trimmed)

  const numMatch = trimmed.match(/(\d{1,6})/)
  if (!numMatch) {
    return candidates
  }

  const rawDigits = numMatch[1]
  const asNumber = Number.parseInt(rawDigits, 10)
  if (Number.isNaN(asNumber)) {
    return candidates
  }

  candidates.add(rawDigits)
  candidates.add(String(asNumber))

  // 법제처 별표번호는 관행적으로 000100, 000200 형식이 많아 둘 다 허용
  candidates.add(String(asNumber).padStart(6, "0"))
  if (rawDigits.length <= 3) {
    candidates.add(String(asNumber * 100).padStart(6, "0"))
  }

  return candidates
}

function extractSelectorNumbers(selector: string): string[] {
  const numbers = new Set<string>()
  const numMatch = selector.match(/(\d{1,6})/)
  if (!numMatch) {
    return []
  }

  const rawDigits = numMatch[1]
  const asNumber = Number.parseInt(rawDigits, 10)
  if (Number.isNaN(asNumber)) {
    return []
  }

  numbers.add(String(asNumber))

  if (rawDigits.length === 6 && asNumber % 100 === 0) {
    numbers.add(String(asNumber / 100))
  }

  return Array.from(numbers)
}

function titleMatchesAnnexNumber(title: string, annexNumber: string): boolean {
  const escapedNumber = escapeRegex(annexNumber)
  const patterns = [
    new RegExp(`\\[\\s*별표\\s*${escapedNumber}\\s*\\]`),
    new RegExp(`별표\\s*제?\\s*${escapedNumber}\\s*(?:호)?`),
    new RegExp(`\\[\\s*별지\\s*${escapedNumber}\\s*\\]`),
    new RegExp(`별지\\s*제?\\s*${escapedNumber}\\s*(?:호)?`),
    new RegExp(`\\[\\s*서식\\s*${escapedNumber}\\s*\\]`),
    new RegExp(`서식\\s*제?\\s*${escapedNumber}\\s*(?:호)?`)
  ]

  if (patterns.some((pattern) => pattern.test(title))) {
    return true
  }

  // 묶음 별표 범위 매칭: "[별표1~5]", "[별표 1 ~ 5]" 등
  const num = Number.parseInt(annexNumber, 10)
  if (!Number.isNaN(num)) {
    const rangePattern = /별표\s*(\d+)\s*[~\-]\s*(\d+)/g
    let match: RegExpExecArray | null
    while ((match = rangePattern.exec(title)) !== null) {
      const start = Number.parseInt(match[1], 10)
      const end = Number.parseInt(match[2], 10)
      if (num >= start && num <= end) {
        return true
      }
    }
  }

  return false
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** 묶음 별표 여부 판별: "[별표1~5]" 같은 범위 표기가 있는지 */
function isBundledAnnex(annexTitle: string): boolean {
  return /별표\s*\d+\s*[~\-]\s*\d+/.test(annexTitle)
}

/** 묶음 별표 마크다운에서 특정 별표 섹션만 추출 */
function extractBundledSection(markdown: string, targetNum: string): string | null {
  const num = parseInt(targetNum, 10)
  if (isNaN(num)) return null

  const pattern = new RegExp(
    `(##\\s*\\[별표\\s*${num}\\][\\s\\S]*?)(?=##\\s*\\[별표\\s*\\d|$)`
  )
  const match = markdown.match(pattern)
  return match ? match[1].trim() : null
}

/**
 * 관련법규명으로 annexList 필터링: 사용자 쿼리와 가장 일치하는 조례 우선
 * 여러 조례(예: "광진구의회 복무 조례" vs "광진구 복무 조례")가 혼합된 경우 분리
 */
function filterByRelatedLawName(annexList: AnnexItem[], queryName: string): AnnexItem[] {
  if (annexList.length <= 1) return annexList

  // 쿼리에서 단어 추출
  const queryWords = queryName.split(/\s+/).filter((w) => w.length > 0)
  if (queryWords.length === 0) return annexList

  // 각 항목에 관련법규명 단어 매칭 점수 부여
  const scored = annexList.map((annex: AnnexItem) => {
    const relatedName = String(annex.관련자치법규명 || annex.관련법령명 || annex.관련행정규칙명 || "")
      .replace(/<[^>]+>/g, "")   // HTML 태그 제거
    const relatedWords = relatedName.split(/\s+/).filter((w) => w.length > 0)
    // 쿼리 단어가 관련법규명에 정확히 포함되는 수
    const score = queryWords.filter((qw) => relatedWords.includes(qw)).length
    return { annex, score }
  })

  const maxScore = Math.max(...scored.map((s) => s.score))
  if (maxScore === 0) return annexList

  // 최고 점수 항목만 필터 (동점 허용)
  const best = scored.filter((s) => s.score === maxScore).map((s) => s.annex)
  return best.length > 0 ? best : annexList
}
