'use client';

import { useRef, useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import { fmt } from '@/lib/format';
import { Button, EmptyState, Spinner } from './primitives';

type OwnerType =
  | 'ITEM'
  | 'PARTNER'
  | 'SALES_DOC'
  | 'PURCHASE_DOC'
  | 'STOCK_DOC'
  | 'JOURNAL'
  | 'APPROVAL_DOC'
  | 'EMPLOYEE_DOC'
  | 'MIGRATION';

/** UIX-07 / NFR-SEC-07: uploads and downloads are permission-checked on the server. */
export function AttachmentPanel({
  ownerType,
  ownerId,
  readOnly,
}: {
  ownerType: OwnerType;
  ownerId: string;
  readOnly?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const list = api.attachment.list.useQuery({ ownerType, ownerId }, { enabled: !!ownerId });
  const upload = api.attachment.upload.useMutation();
  const remove = api.attachment.remove.useMutation();
  const downloadUrl = api.attachment.downloadUrl.useMutation();

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const buffer = await file.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      await upload.mutateAsync({
        ownerType,
        ownerId,
        originalName: file.name,
        mimeType: file.type || 'application/octet-stream',
        contentBase64: base64,
        requestId: newRequestId(),
      });
      await list.refetch();
    } catch (err) {
      setError((err as { message?: string }).message ?? '업로드에 실패했습니다.');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function open(attachmentId: string) {
    setError(null);
    try {
      const res = await downloadUrl.mutateAsync({ attachmentId });
      window.open(res.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError((err as { message?: string }).message ?? '다운로드 링크를 만들 수 없습니다.');
    }
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
        <h2 className="text-sm font-semibold">첨부파일</h2>
        {!readOnly ? (
          <>
            <input
              ref={fileRef}
              type="file"
              className="sr-only"
              id={`file-${ownerType}-${ownerId}`}
              onChange={onPick}
            />
            <Button size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
              {busy ? '업로드 중…' : '파일 추가'}
            </Button>
          </>
        ) : null}
      </header>

      {error ? (
        <p role="alert" className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {list.isLoading ? (
        <Spinner />
      ) : (list.data ?? []).length === 0 ? (
        <EmptyState
          title="첨부된 파일이 없습니다."
          description={readOnly ? undefined : '20MB 이하의 PDF·이미지·엑셀·문서 파일을 추가할 수 있습니다.'}
        />
      ) : (
        <ul className="divide-y divide-slate-100">
          {(list.data ?? []).map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
              <button
                type="button"
                className="truncate text-left text-blue-700 hover:underline"
                onClick={() => open(a.id)}
              >
                {a.originalName}
              </button>
              <span className="flex shrink-0 items-center gap-3 text-xs text-slate-500">
                <span className="tabular">{Math.ceil(a.size / 1024).toLocaleString('ko-KR')} KB</span>
                <span>{fmt.date(a.createdAt as unknown as string)}</span>
                {!readOnly ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await remove.mutateAsync({ attachmentId: a.id, requestId: newRequestId() });
                      await list.refetch();
                    }}
                  >
                    삭제
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
