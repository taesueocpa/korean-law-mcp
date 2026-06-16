#!/usr/bin/env node

/**
 * get_annexes — 행정규칙 별표/서식(target=admbyl) 지원 테스트
 *
 * 케이스:
 *   A. 행정규칙 ID(adminRuleId)로 「외감세칙 별표 6」 회수 → 본문에 평가/보고 기준 포함
 *   B. 행정규칙명(lawName + 별표6)으로 회수
 *   C. (회귀) 기존 법령 별표 목록 조회 정상 동작
 *   D. 존재하지 않는 별표 → [NOT_FOUND] + isError
 *
 * 라이브 법제처 API 호출이 필요하므로 .env 의 LAW_OC 가 있어야 한다.
 * 키가 없으면 SKIP(exit 0).
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const idx = trimmed.indexOf('=');
        if (idx > 0) {
          const key = trimmed.slice(0, idx).trim();
          const value = trimmed.slice(idx + 1).trim();
          if (key) process.env[key] = value;
        }
      }
    }
  }
}

loadEnv();

// ── 관찰된 식별자 (라이브 확인 대상) ─────────────────────
// 「외부감사 및 회계 등에 관한 규정 시행세칙」 별표 6 「내부회계관리제도 평가 및 보고 기준」
const ADMIN_RULE_NAME = '외부감사 및 회계 등에 관한 규정 시행세칙';
const ADMIN_RULE_SEQ = '2200000108723'; // 행정규칙일련번호 (MCP search 기준)
const ANNEX6_KEYWORD = '내부회계관리제도';

let serverProcess = null;

function startServer() {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, '..', 'build', 'index.js');
    serverProcess = spawn('node', [serverPath], {
      env: { ...process.env, LAW_OC: process.env.LAW_OC },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let initialized = false;
    serverProcess.on('error', reject);
    serverProcess.on('exit', (code) => {
      if (!initialized) reject(new Error(`Server exited with code ${code}`));
    });

    let initBuf = '';
    const onInitData = (data) => {
      initBuf += data.toString();
      for (const line of initBuf.split('\n')) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line);
          if (resp.id === 'init' && !initialized) {
            initialized = true;
            serverProcess.stdout.removeListener('data', onInitData);
            serverProcess.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
            setTimeout(resolve, 300);
            return;
          }
        } catch (e) {}
      }
    };
    serverProcess.stdout.on('data', onInitData);
    setTimeout(() => {
      serverProcess.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 'init', method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      }) + '\n');
    }, 300);
    setTimeout(() => { if (!initialized) reject(new Error('initialize timeout (8s)')); }, 8000);
  });
}

function callTool(toolName, args, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const request = { jsonrpc: '2.0', id: Date.now() + Math.floor(Math.random() * 1000), method: 'tools/call', params: { name: toolName, arguments: args } };
    let responseData = '';
    const dataHandler = (data) => {
      responseData += data.toString();
      for (const line of responseData.split('\n').filter((l) => l.trim())) {
        try {
          const response = JSON.parse(line);
          if (response.id === request.id) {
            serverProcess.stdout.removeListener('data', dataHandler);
            resolve(response);
            return;
          }
        } catch (e) {}
      }
    };
    serverProcess.stdout.on('data', dataHandler);
    serverProcess.stdin.write(JSON.stringify(request) + '\n');
    setTimeout(() => {
      serverProcess.stdout.removeListener('data', dataHandler);
      reject(new Error(`Timeout: ${toolName}`));
    }, timeoutMs);
  });
}

const textOf = (resp) => (resp && resp.result && resp.result.content && resp.result.content[0] && resp.result.content[0].text) || '';
const isErr = (resp) => !!(resp && resp.result && resp.result.isError);

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.log(`❌ ${name}${detail ? `\n   ${detail}` : ''}`); }
}

async function run() {
  console.log('========================================');
  console.log('get_annexes 행정규칙 별표(admbyl) 테스트');
  console.log('========================================\n');

  if (!process.env.LAW_OC) {
    console.log('⏭️  SKIP: LAW_OC 환경변수 없음 (라이브 API 키 필요)');
    process.exit(0);
  }

  await startServer();
  console.log('✅ Server started\n');

  try {
    // ── A. 행정규칙 ID로 별표 6 본문 추출 ──
    console.log('── A. adminRuleId 로 외감세칙 별표 6 ──');
    const a = await callTool('get_annexes', { lawName: ADMIN_RULE_NAME, adminRuleId: ADMIN_RULE_SEQ, annexNo: '6' });
    const aText = textOf(a);
    console.log(aText.slice(0, 400) + '\n');
    check('A: 별표 6 본문 회수 (내부회계관리제도)', !isErr(a) && aText.includes(ANNEX6_KEYWORD), `isError=${isErr(a)}`);

    // ── B. 행정규칙명 + 별표6 (ID 없이 이름만) ──
    console.log('── B. 이름만으로 별표 6 ──');
    const b = await callTool('get_annexes', { lawName: `${ADMIN_RULE_NAME} 별표6` });
    const bText = textOf(b);
    console.log(bText.slice(0, 300) + '\n');
    check('B: 이름 경로로 별표 6 회수', !isErr(b) && bText.includes(ANNEX6_KEYWORD), `isError=${isErr(b)}`);

    // ── C. 회귀: 법령 별표 목록 ──
    console.log('── C. (회귀) 여권법 시행령 별표 목록 ──');
    const c = await callTool('get_annexes', { lawName: '여권법 시행령' });
    const cText = textOf(c);
    console.log(cText.slice(0, 300) + '\n');
    check('C: 법령 별표 목록 정상 (회귀)', !isErr(c) && /별표|서식/.test(cText), `isError=${isErr(c)}`);

    // ── D. 존재하지 않는 별표 번호 → [NOT_FOUND] ──
    // (행정규칙은 찾았으나 요청한 별표 번호가 없는 경우 = 파일 변환 실패와 구분되는 "데이터 없음")
    console.log('── D. 존재하지 않는 별표 번호 → [NOT_FOUND] ──');
    const d = await callTool('get_annexes', { lawName: ADMIN_RULE_NAME, adminRuleId: ADMIN_RULE_SEQ, annexNo: '999' });
    const dText = textOf(d);
    console.log(dText.slice(0, 200) + '\n');
    check('D: [NOT_FOUND] + isError', isErr(d) && dText.includes('[NOT_FOUND]'), `isError=${isErr(d)}`);
  } catch (e) {
    console.error('\n❌ 예외:', e.message);
    failed++;
  } finally {
    if (serverProcess) serverProcess.kill();
  }

  console.log(`\n────────────\n결과: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
