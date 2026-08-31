// covers: NFR-SEC-07, UIX-07
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { actorFor, prepareDatabase, prisma, runTx, truncateBusinessData } from '../helpers/db';
import * as attachment from '@/server/modules/storage/attachment';
import {
  assertUploadAllowed,
  buildStorageKey,
  MAX_FILE_BYTES,
  verifyLocalSignature,
} from '@/server/modules/storage/service';
import { AppError } from '@/server/core/errors';
import type { Actor } from '@/server/core/context';

/**
 * Uploading the way a router does it: the bytes are staged outside the transaction, then
 * the row is recorded inside it. A test that skipped staging would not exercise the path
 * the application takes.
 */
async function uploadAs(actor: Actor, input: Parameters<typeof attachment.stageUpload>[1]) {
  const staged = await attachment.stageUpload({ actor, now: new Date() }, input);
  try {
    return await runTx(actor, (t) => attachment.upload(t, input, staged));
  } catch (e) {
    await attachment.discardStaged(staged);
    throw e;
  }
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(32, 2)]);

let admin: Actor;
let viewer: Actor;

beforeAll(async () => {
  process.env['STORAGE_LOCAL_DIR'] = await fs.mkdtemp(path.join(os.tmpdir(), 'erp-storage-'));
  prepareDatabase();
  admin = await actorFor('admin');
  const viewerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'viewer' } });
  await prisma.user.upsert({
    where: { username: 'viewer2' },
    create: {
      username: 'viewer2',
      displayName: 'viewer2',
      passwordHash: 'scrypt$1$1$1$x$y',
      roles: { create: [{ roleId: viewerRole.id }] },
    },
    update: {},
  });
  viewer = await actorFor('viewer2');
});

beforeEach(() => truncateBusinessData());
afterAll(() => prisma.$disconnect());

describe('upload validation (NFR-SEC-07)', () => {
  it('accepts an allowed type whose magic bytes match', () => {
    expect(() =>
      assertUploadAllowed({ size: PNG.length, mimeType: 'image/png', originalName: 'a.png', head: PNG }),
    ).not.toThrow();
  });

  it('rejects a disallowed MIME type', () => {
    expect(() =>
      assertUploadAllowed({
        size: 10,
        mimeType: 'application/x-msdownload',
        originalName: 'a.exe',
        head: PDF,
      }),
    ).toThrow(/허용되지 않는/);
  });

  it('rejects an extension that contradicts the declared type', () => {
    expect(() =>
      assertUploadAllowed({ size: PNG.length, mimeType: 'image/png', originalName: 'evil.exe', head: PNG }),
    ).toThrow(/확장자/);
  });

  it('rejects content whose magic bytes contradict the declared type', () => {
    expect(() =>
      assertUploadAllowed({ size: PDF.length, mimeType: 'image/png', originalName: 'fake.png', head: PDF }),
    ).toThrow(/파일 내용/);
  });

  it('rejects empty and oversized files', () => {
    expect(() =>
      assertUploadAllowed({ size: 0, mimeType: 'image/png', originalName: 'a.png', head: PNG }),
    ).toThrow(AppError);
    expect(() =>
      assertUploadAllowed({
        size: MAX_FILE_BYTES + 1,
        mimeType: 'image/png',
        originalName: 'a.png',
        head: PNG,
      }),
    ).toThrow(/20MB/);
  });

  it('never puts the user-supplied filename in the storage key', () => {
    const key = buildStorageKey('EMPLOYEE_DOC', 'application/pdf', new Date('2026-08-30T00:00:00Z'));
    expect(key).toMatch(/^employee_doc\/2026\/08\/[0-9a-f-]{36}\.pdf$/);
    expect(key).not.toContain('..');
  });
});

describe('attachment lifecycle', () => {
  it('stores the file privately and returns an expiring signed URL', async () => {
    const created = await uploadAs(admin, {
      ownerType: 'ITEM',
      ownerId: 'item-1',
      originalName: '도면.png',
      mimeType: 'image/png',
      body: PNG,
    });
    expect(created.storageKey).not.toContain('도면');

    const onDisk = await fs.readFile(path.join(process.env['STORAGE_LOCAL_DIR']!, created.storageKey));
    expect(onDisk.equals(PNG)).toBe(true);

    const link = await runTx(admin, (t) => attachment.downloadUrl(t, created.id));
    expect(link.url).toMatch(/^\/api\/files\/.+exp=\d+&sub=.+&sig=[0-9a-f]{64}$/);
    expect(link.originalName).toBe('도면.png');

    const url = new URL(link.url, 'http://localhost');
    const key = decodeURIComponent(url.pathname.replace('/api/files/', ''));
    const exp = url.searchParams.get('exp')!;
    const sub = url.searchParams.get('sub')!;
    const sig = url.searchParams.get('sig')!;
    expect(sub).toBe(admin.userId);
    expect(verifyLocalSignature(key, exp, sig, sub)).toBe(true);
    expect(verifyLocalSignature(key, exp, 'f'.repeat(64), sub)).toBe(false);
  });

  /**
   * NFR-SEC-07: the link names the user it was issued to. Before this, the signature
   * covered only the key and the expiry, so a leaked URL was a bearer token for the file —
   * anyone holding it could fetch an employment contract with no account at all.
   */
  it('다른 사용자의 이름으로는 같은 링크가 통하지 않는다', async () => {
    const created = await uploadAs(admin, {
      ownerType: 'ITEM',
      ownerId: 'item-sub',
      originalName: 'bound.png',
      mimeType: 'image/png',
      body: PNG,
    });
    const link = await runTx(admin, (t) => attachment.downloadUrl(t, created.id));
    const url = new URL(link.url, 'http://localhost');
    const key = decodeURIComponent(url.pathname.replace('/api/files/', ''));
    const exp = url.searchParams.get('exp')!;
    const sig = url.searchParams.get('sig')!;

    expect(verifyLocalSignature(key, exp, sig, admin.userId)).toBe(true);
    expect(verifyLocalSignature(key, exp, sig, 'someone-else')).toBe(false);
    expect(verifyLocalSignature(key, exp, sig, '')).toBe(false);
  });

  /** A malformed signature must be refused, not crash the route with a length mismatch. */
  it('형식이 잘못된 서명은 예외가 아니라 거부로 처리한다', async () => {
    expect(() =>
      verifyLocalSignature('k', String(Math.floor(Date.now() / 1000) + 60), '한'.repeat(64), 'u'),
    ).not.toThrow();
    expect(verifyLocalSignature('k', String(Math.floor(Date.now() / 1000) + 60), '한'.repeat(64), 'u')).toBe(
      false,
    );
    expect(verifyLocalSignature('k', 'not-a-number', 'f'.repeat(64), 'u')).toBe(false);
  });

  it('expired signatures are refused', async () => {
    const created = await uploadAs(admin, {
      ownerType: 'ITEM',
      ownerId: 'item-2',
      originalName: 'a.png',
      mimeType: 'image/png',
      body: PNG,
    });
    const link = await runTx(admin, (t) => attachment.downloadUrl(t, created.id, -10));
    const url = new URL(link.url, 'http://localhost');
    const key = decodeURIComponent(url.pathname.replace('/api/files/', ''));
    expect(
      verifyLocalSignature(
        key,
        url.searchParams.get('exp')!,
        url.searchParams.get('sig')!,
        url.searchParams.get('sub')!,
      ),
    ).toBe(false);
  });

  it('checks the owning entity permission on upload, list and download', async () => {
    const created = await uploadAs(admin, {
      ownerType: 'EMPLOYEE_DOC',
      ownerId: 'emp-1',
      originalName: '계약서.pdf',
      mimeType: 'application/pdf',
      body: PDF,
    });

    await expect(
      uploadAs(viewer, {
        ownerType: 'EMPLOYEE_DOC',
        ownerId: 'emp-1',
        originalName: 'x.pdf',
        mimeType: 'application/pdf',
        body: PDF,
      }),
    ).rejects.toThrow(/권한이 없습니다/);

    await expect(runTx(viewer, (t) => attachment.downloadUrl(t, created.id))).rejects.toThrow(
      /권한이 없습니다/,
    );
    await expect(runTx(viewer, (t) => attachment.list(t, 'EMPLOYEE_DOC', 'emp-1'))).rejects.toThrow(
      /권한이 없습니다/,
    );
  });

  it("NFR-SEC-02: hr.self reads only the actor's own employee documents", async () => {
    const employee = await prisma.employee.upsert({
      where: { employeeNo: 'E9001' },
      create: { employeeNo: 'E9001', name: '본인', hireDate: new Date('2025-01-02T00:00:00Z') },
      update: {},
    });
    await prisma.user.update({ where: { username: 'viewer2' }, data: { employeeId: employee.id } });
    const self = await actorFor('viewer2');

    const own = await uploadAs(admin, {
      ownerType: 'EMPLOYEE_DOC',
      ownerId: employee.id,
      originalName: 'own.pdf',
      mimeType: 'application/pdf',
      body: PDF,
    });
    const others = await uploadAs(admin, {
      ownerType: 'EMPLOYEE_DOC',
      ownerId: 'someone-else',
      originalName: 'other.pdf',
      mimeType: 'application/pdf',
      body: PDF,
    });

    await expect(runTx(self, (t) => attachment.downloadUrl(t, own.id))).resolves.toMatchObject({
      originalName: 'own.pdf',
    });
    await expect(runTx(self, (t) => attachment.downloadUrl(t, others.id))).rejects.toThrow(/권한이 없습니다/);
    // still cannot upload into their own file set
    await expect(
      uploadAs(self, {
        ownerType: 'EMPLOYEE_DOC',
        ownerId: employee.id,
        originalName: 'x.pdf',
        mimeType: 'application/pdf',
        body: PDF,
      }),
    ).rejects.toThrow(/권한이 없습니다/);
    await prisma.user.update({ where: { username: 'viewer2' }, data: { employeeId: null } });
  });

  it('records uploads and downloads in the audit log', async () => {
    const created = await uploadAs(admin, {
      ownerType: 'ITEM',
      ownerId: 'item-3',
      originalName: 'b.png',
      mimeType: 'image/png',
      body: PNG,
    });
    await runTx(admin, (t) => attachment.downloadUrl(t, created.id));
    const actions = (await prisma.auditLog.findMany({ where: { entityType: 'Attachment' } })).map(
      (a) => a.action,
    );
    expect(actions).toContain('attachment.upload');
    expect(actions).toContain('attachment.download');
    expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain(created.storageKey);
  });

  it('soft-deleted attachments disappear from listings', async () => {
    const created = await uploadAs(admin, {
      ownerType: 'ITEM',
      ownerId: 'item-4',
      originalName: 'c.png',
      mimeType: 'image/png',
      body: PNG,
    });
    expect(await runTx(admin, (t) => attachment.list(t, 'ITEM', 'item-4'))).toHaveLength(1);
    await runTx(admin, (t) => attachment.softDelete(t, created.id));
    expect(await runTx(admin, (t) => attachment.list(t, 'ITEM', 'item-4'))).toHaveLength(0);
    await expect(runTx(admin, (t) => attachment.downloadUrl(t, created.id))).rejects.toThrow(
      /찾을 수 없습니다/,
    );
  });
});
