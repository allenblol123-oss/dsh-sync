import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const I = require('../src/index.js').__internals

// 0.4.5：非 GitCode 托管方支持。detectRepoProvider 只做纯字符串识别，
// 每个未知/自建主机都必须落到 'generic'（= 私有性无法远端判定）。

test('detectRepoProvider: 已知托管方 / 自建主机 / ssh 形式', () => {
  assert.deepEqual(I.detectRepoProvider('https://gitcode.com/o/r.git'), { kind: 'gitcode', host: 'gitcode.com', owner: 'o', repo: 'r' })
  assert.equal(I.detectRepoProvider('https://github.com/o/r').kind, 'github')
  const gl = I.detectRepoProvider('https://gitlab.com/group/sub/r.git')
  assert.equal(gl.kind, 'gitlab')
  assert.equal(gl.owner, 'group/sub', 'GitLab 嵌套 group 的 owner 要带路径')
  assert.equal(gl.repo, 'r')
  assert.equal(I.detectRepoProvider('https://gitee.com/o/r').kind, 'gitee')
  assert.equal(I.detectRepoProvider('git@github.com:o/r.git').kind, 'github')
  assert.equal(I.detectRepoProvider('https://git.internal.corp/team/repo.git').kind, 'generic')
  assert.equal(I.detectRepoProvider('http://192.168.1.9/o/r.git').kind, 'generic')
  assert.equal(I.detectRepoProvider('').kind, 'none')
  assert.equal(I.detectRepoProvider('not a url').owner, '')
})

test('gitUsernameForProvider: GitHub 要 x-access-token，其余 oauth2', () => {
  assert.equal(I.gitUsernameForProvider('https://github.com/o/r.git'), 'x-access-token')
  assert.equal(I.gitUsernameForProvider('https://gitlab.com/o/r.git'), 'oauth2')
  assert.equal(I.gitUsernameForProvider('https://gitcode.com/o/r.git'), 'oauth2')
  assert.equal(I.gitUsernameForProvider(undefined), 'oauth2')
  const env = I.gitAuthEnv({ token: 't', repoUrl: 'https://github.com/o/r.git' })
  assert.equal(env.DSH_SYNC_USER, 'x-access-token')
  assert.equal(env.DSH_SYNC_TOKEN, 't')
  assert.ok(I.ASKPASS_SH.includes('DSH_SYNC_USER'), 'askpass 必须按 provider 取用户名')
})

test('checkRepoAccess: 已知 provider 查 REST 判私有性', async () => {
  const orig = globalThis.fetch
  const mk = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj), json: async () => obj })
  const seen = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    seen.push({ u, h: (init && init.headers) || {} })
    if (u === 'https://api.github.com/repos/o/priv') return mk({ private: true, default_branch: 'trunk' })
    if (u === 'https://api.github.com/repos/o/pub') return mk({ private: false })
    if (u.startsWith('https://gitee.com/api/v5/repos/o/priv')) return mk({ private: true, default_branch: 'main' })
    if (u === 'https://gitlab.com/api/v4/projects/g%2Fsub%2Fpriv') return mk({ visibility: 'internal' })
    if (u === 'https://gitlab.com/api/v4/projects/g%2Fsub%2Fpub') return mk({ visibility: 'public' })
    if (u.includes('api.gitcode.com')) return mk({ private: true, default_branch: 'main' })
    return mk({ message: 'not found' }, 404)
  }
  try {
    const gh = await I.checkRepoAccess('tok', 'https://github.com/o/priv.git')
    assert.equal(gh.ok, true)
    assert.equal(gh.verified, true)
    assert.equal(gh.defaultBranch, 'trunk')
    assert.equal(seen[0].h.Authorization, 'Bearer tok')
    const pub = await I.checkRepoAccess('tok', 'https://github.com/o/pub.git')
    assert.equal(pub.ok, false)
    assert.equal(pub.isPublic, true)
    assert.equal(pub.provider.kind, 'github')
    // GitLab：internal 不算公开；项目路径必须整体 urlencode
    assert.equal((await I.checkRepoAccess('tok', 'https://gitlab.com/g/sub/priv.git')).ok, true)
    assert.equal((await I.checkRepoAccess('tok', 'https://gitlab.com/g/sub/pub.git')).ok, false)
    assert.ok(seen.some(s => s.u === 'https://gitlab.com/api/v4/projects/g%2Fsub%2Fpriv' && s.h['PRIVATE-TOKEN'] === 'tok'),
      'GitLab 需要 PRIVATE-TOKEN + urlencode 的项目路径')
    assert.equal((await I.checkRepoAccess('tok', 'https://gitee.com/o/priv.git')).ok, true)
    const gc = await I.checkRepoAccess('tok', 'https://gitcode.com/o/r.git')
    assert.equal(gc.ok, true)
    assert.equal(gc.provider.kind, 'gitcode')
    // Gitee 的 v5 API 只认 ?access_token=（官方要求），别的 provider 一律走 header
    assert.ok(!seen.some(s => /(github|gitlab|gitcode|git\.internal)/.test(s.u) && s.u.includes('tok')), 'token 只能走 header')
    assert.ok(seen.some(s => s.u.startsWith('https://gitee.com/api/v5/repos/o/priv') && s.u.includes('access_token=tok')), 'Gitee 走 access_token 查询参数')
    const bad = await I.checkRepoAccess('tok', 'not a url')
    assert.equal(bad.ok, false)
    assert.ok(/无法解析仓库地址/.test(bad.error))
  } finally { globalThis.fetch = orig }
})

test('checkRepoAccess: 自建/未知主机判不了私有性 → 必须用户确认风险', async () => {
  const no = await I.checkRepoAccess('tok', 'https://git.internal.corp/team/repo.git')
  assert.equal(no.ok, false)
  assert.equal(no.needConfirm, true)
  assert.equal(no.code, 'UNVERIFIED_REPO')
  assert.equal(no.provider.kind, 'generic')
  assert.ok(/私有/.test(no.error) && /泄露/.test(no.error), '文案必须说清密钥泄露风险: ' + no.error)
  const yes = await I.checkRepoAccess('tok', 'https://git.internal.corp/team/repo.git', { allowUnverified: true })
  assert.equal(yes.ok, true)
  assert.equal(yes.verified, false)
  assert.equal(yes.unverified, true)
})

// ── fork 增强：GitHub 的 分支→PR→合并 适配层 ──

test('github PR API: 创建/查询/合并（Authorization: Bearer + 标准 REST 端点）', async () => {
  const orig = globalThis.fetch
  const calls = []
  const mk = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj) })
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init && init.method, body: init && init.body, headers: (init && init.headers) || {} })
    const u = String(url)
    if (u.endsWith('/repos/o/priv/pulls') && init.method === 'POST') return mk({ number: 12 }, 201)
    if (u.endsWith('/repos/o/priv/pulls/12')) return mk({ number: 12, mergeable: true })
    if (u.endsWith('/repos/o/priv/pulls/12/merge')) return mk({ merged: true }, 200)
    return mk({ message: 'not found' }, 404)
  }
  try {
    const created = await I.githubCreatePullRequest('tok', 'o', 'priv', { head: 'b', base: 'main', title: 't', body: 'x' })
    assert.equal(created.ok, true)
    assert.equal(created.json.number, 12)
    assert.equal(calls[0].url, 'https://api.github.com/repos/o/priv/pulls')
    assert.equal(calls[0].headers.Authorization, 'Bearer tok')
    assert.deepEqual(JSON.parse(calls[0].body), { head: 'b', base: 'main', title: 't', body: 'x' })

    const got = await I.githubGetPullRequest('tok', 'o', 'priv', 12)
    assert.equal(got.json.mergeable, true)

    const merged = await I.githubMergePullRequest('tok', 'o', 'priv', 12, 'squash')
    assert.equal(merged.ok, true)
    assert.equal(calls[calls.length - 1].method, 'PUT')
    assert.deepEqual(JSON.parse(calls[calls.length - 1].body), { merge_method: 'squash' })
  } finally { globalThis.fetch = orig }
})

test('githubWaitMergeable: mergeable 异步计算，轮询到确定值（null → true/false）', async () => {
  const orig = globalThis.fetch
  const mk = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) })
  let n = 0
  globalThis.fetch = async () => { n++; return n < 3 ? mk({ mergeable: null }) : mk({ mergeable: true }) }
  try {
    const r = await I.githubWaitMergeable('tok', 'o', 'r', 1, { tries: 5, delayMs: 1 })
    assert.equal(r.mergeable, true)
    assert.equal(r.conflict, false)
    assert.ok(n >= 3, '必须轮询到非 null 才返回')
  } finally { globalThis.fetch = orig }

  globalThis.fetch = async () => mk({ mergeable: false })
  try {
    const r2 = await I.githubWaitMergeable('tok', 'o', 'r', 2, { tries: 3, delayMs: 1 })
    assert.equal(r2.mergeable, false)
    assert.equal(r2.conflict, true)
  } finally { globalThis.fetch = orig }
})

test('prChannelFor: GitHub 走 PR 通道，GitCode 保持原通道，其他主机降级为 null', () => {
  assert.deepEqual(I.prChannelFor('https://github.com/o/r.git'), { kind: 'github', owner: 'o', repo: 'r' })
  assert.deepEqual(I.prChannelFor('git@github.com:o/r.git'), { kind: 'github', owner: 'o', repo: 'r' })
  assert.deepEqual(I.prChannelFor('https://gitcode.com/o/r.git'), { kind: 'gitcode', owner: 'o', repo: 'r' })
  assert.equal(I.prChannelFor('https://git.internal.corp/team/repo.git'), null, '自建主机仍只推分支')
  assert.equal(I.prChannelFor(''), null)
})

// ── fork 增强：session 日志（.jsonl.zstd）无损自动合并 ──

const zlib = require('node:zlib')
const frameLine = (line) => zlib.zstdCompressSync(Buffer.from(line + '\n', 'utf8'))
const frameLines = (lines) => Buffer.concat(lines.map(frameLine))
const readMerged = (buf) => I.decompressZstdFrames(buf).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

test('mergeSessionZstdBuffers: 按 seq 取并集、去重、排序（一边只是多追加）', () => {
  const session = JSON.stringify({ type: 'session', version: 4, id: 's1', createdAt: 1 })
  const ev = (seq, time, type) => JSON.stringify({ type, seq, time, data: {} })
  const ours = frameLines([session, ev(0, 100, 'user/message'), ev(1, 200, 'assistant/message')])
  const theirs = frameLines([session, ev(0, 100, 'user/message'), ev(1, 200, 'assistant/message'), ev(2, 300, 'tool/call')])
  const merged = readMerged(I.mergeSessionZstdBuffers(ours, theirs))
  assert.equal(merged.length, 4, '并集不重复')
  assert.deepEqual(merged.map((x) => x.seq ?? 'session'), ['session', 0, 1, 2], '按 seq 排序、session 行在前')
  // 幂等：把合并结果再并一次不应增长
  assert.equal(readMerged(I.mergeSessionZstdBuffers(I.mergeSessionZstdBuffers(ours, theirs), theirs)).length, 4)
})

test('mergeSessionZstdBuffers: 同 seq 内容不同取 time 较新的一行', () => {
  const a = frameLines([JSON.stringify({ type: 'user/message', seq: 0, time: 100, data: { v: 'old' } })])
  const b = frameLines([JSON.stringify({ type: 'user/message', seq: 0, time: 200, data: { v: 'new' } })])
  const merged = readMerged(I.mergeSessionZstdBuffers(a, b))
  assert.equal(merged.length, 1)
  assert.equal(merged[0].data.v, 'new')
})

test('mergeSessionZstdBuffers: 任一边不是合法 zstd 时保留另一边，不制造坏文件', () => {
  const good = frameLines([JSON.stringify({ type: 'session', version: 4 })])
  const bad = Buffer.from('not a zstd file')
  assert.deepEqual(I.mergeSessionZstdBuffers(bad, good), good)
  assert.deepEqual(I.mergeSessionZstdBuffers(good, bad), good)
})

test('isSessionLogPath: 只匹配 session 日志，普通文本/其他二进制不碰', () => {
  assert.equal(I.isSessionLogPath('sessions/--x--/session-a/session.v4.jsonl.zstd'), true)
  assert.equal(I.isSessionLogPath('settings/settings.yaml'), false)
  assert.equal(I.isSessionLogPath('skills/dsh/foo/SKILL.md'), false)
  assert.equal(I.isSessionLogPath('plugins/desktop/package.json'), false)
  assert.equal(I.isSessionLogPath(''), false)
})

// ── fork 增强：包名变更后 profile patch 的自愈 ──

test('healProfilePatchName: 旧包名就地改写，其余内容与 !!js 表达式不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-heal-'))
  try {
    const p = join(dir, 'cordis.patch.yml')
    const before = [
      '# comment',
      '- id: ui-chat',
      '  name: "@deepseek-ai/dsh-client-ui-chat"',
      '  config:',
      '    disabled: !!js "!ctx.get(\'x\')"',
      '- id: dsh-sync',
      '  name: "@weibaohui/dsh-sync"',
      '  config:',
      '    sync:',
      '      repoUrl: https://github.com/o/r.git',
      '',
    ].join('\n')
    writeFileSync(p, before)
    const r = I.healProfilePatchName(p, '@allenblol123-oss/dsh-sync')
    assert.equal(r.changed, true)
    assert.equal(r.from, '@weibaohui/dsh-sync')
    assert.equal(r.to, '@allenblol123-oss/dsh-sync')
    const after = readFileSync(p, 'utf8')
    assert.ok(after.includes('name: "@allenblol123-oss/dsh-sync"'))
    assert.ok(after.includes('!!js "!ctx.get(\'x\')"'), '其它行的 !!js 表达式必须原样保留')
    assert.ok(after.includes('repoUrl: https://github.com/o/r.git'), '配置内容不能动')
    // 幂等：已经是当前包名时不再改写
    assert.equal(I.healProfilePatchName(p, '@allenblol123-oss/dsh-sync').changed, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('healProfilePatchName: 没有 dsh-sync 行 / 没有 name 行时不乱改', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-heal-'))
  try {
    const p = join(dir, 'cordis.patch.yml')
    writeFileSync(p, '- id: other\n  name: "@x/y"\n')
    assert.equal(I.healProfilePatchName(p, '@a/b').reason, 'no-row')
    writeFileSync(p, '- id: dsh-sync\n  config: {}\n')
    assert.equal(I.healProfilePatchName(p, '@a/b').reason, 'no-name')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('PACKAGE_NAME: 指向当前包（fork 名）', () => {
  assert.equal(I.PACKAGE_NAME, '@allenblol123-oss/dsh-sync')
})
