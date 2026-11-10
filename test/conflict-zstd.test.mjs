import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const I = require('../src/index.js').__internals
const zlib = require('node:zlib')

const frame = (obj) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(obj) + '\n'))
const sessionBuf = (events) => Buffer.concat(events.map(frame))
const readAll = (buf) => I.decompressZstdFrames(buf).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'pipe' })

test('prepareConflictTree: 会话日志（.jsonl.zstd）冲突自动无损合并（真实 git 仓库）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-zstd-'))
  try {
    const bare = join(tmp, 'remote.git')
    git(['init', '--bare', '-b', 'main', bare], tmp)

    // seed：main 上放一个 session 日志（session 头 + seq0）
    const seed = join(tmp, 'seed')
    mkdirSync(seed, { recursive: true })
    git(['init', '-b', 'main'], seed)
    git(['config', 'user.name', 't'], seed)
    git(['config', 'user.email', 't@t'], seed)
    const rel = 'sessions/--ws--/session-a/session.v4.jsonl.zstd'
    mkdirSync(join(seed, 'sessions', '--ws--', 'session-a'), { recursive: true })
    const base = [
      { type: 'session', version: 4, id: 'session-a' },
      { type: 'msg', seq: 0, time: 1, data: {} },
    ]
    writeFileSync(join(seed, rel), sessionBuf(base))
    git(['add', '-A'], seed)
    git(['commit', '-m', 'base'], seed)
    git(['push', bare, 'main'], seed)

    // sync 分支：追加 seq1
    const work = join(tmp, 'work')
    git(['clone', bare, work], tmp)
    git(['config', 'user.name', 't'], work)
    git(['config', 'user.email', 't@t'], work)
    git(['checkout', '-b', 'sync/t/1'], work)
    writeFileSync(join(work, rel), sessionBuf([...base, { type: 'msg', seq: 1, time: 2, data: { from: 'branch' } }]))
    git(['add', '-A'], work)
    git(['commit', '-m', 'branch seq1'], work)
    git(['push', bare, 'sync/t/1'], work)

    // main：追加 seq2（同一文件不同内容 → 冲突）
    git(['checkout', 'main'], work)
    writeFileSync(join(work, rel), sessionBuf([...base, { type: 'msg', seq: 2, time: 3, data: { from: 'main' } }]))
    git(['add', '-A'], work)
    git(['commit', '-m', 'main seq2'], work)
    git(['push', bare, 'main'], work)

    const prep = await I.prepareConflictTree('git', { repoUrl: bare, branch: 'main' }, { repoDir: work, branch: 'sync/t/1' })
    assert.equal(prep.conflicts.length, 0, '会话日志冲突应被自动消化，不留给 AI：' + JSON.stringify(prep.conflicts))
    assert.equal(prep.autoMerged, true, '自动合并后应可直接收尾（merge 提交已补上）')
    assert.deepEqual(prep.autoResolved.map((p) => p.replace(/\\/g, '/')), [rel])
    const merged = readAll(readFileSync(join(work, rel)))
    assert.deepEqual(merged.filter((x) => x.seq !== undefined).map((x) => x.seq), [0, 1, 2], '两边的追加都保留且按 seq 排序')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
