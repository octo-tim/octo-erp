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

/** Types the browser can render in-page; everything else falls back to open-in-new-tab. */
function isPreviewable(mimeType: string): boolean {
  return mimeType.startsWith('image/') || mimeType === 'application/pdf';
}

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
  // The signed URL is bound to this user and short-lived — it lives only in this component's
  // state for as long as the preview is open, and is dropped (not just hidden) when it closes.
  const [preview, setPreview] = useState<{ id: string; url: string; mimeType: string; name: string } | null>(
    null,
  );
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);

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

  /** UIX-07 미리보기: images and PDFs render in-page; other types fall back to a new tab. */
  async function open(attachment: { id: string; originalName: string; mimeType: string }) {
    setError(null);
    if (preview?.id === attachment.id) {
      // toggling the same file closed — drop the signed URL rather than leave it sitting in state
      setPreview(null);
      return;
    }
    setPreviewLoading(attachment.id);
    try {
      const res = await downloadUrl.mutateAsync({ attachmentId: attachment.id });
      if (isPreviewable(attachment.mimeType)) {
        setPreview({
          id: attachment.id,
          url: res.url,
          mimeType: attachment.mimeType,
          name: attachment.originalName,
        });
      } else {
        window.open(res.url, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      setError((err as { message?: string }).message ?? '다운로드 링크를 만들 수 없습니다.');
    } finally {
      setPreviewLoading(null);
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
            <li key={a.id} className="flex flex-col gap-2 px-4 py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  className="truncate text-left text-blue-700 hover:underline"
                  disabled={previewLoading === a.id}
                  onClick={() => open(a)}
                >
                  {previewLoading === a.id
                    ? '불러오는 중…'
                    : preview?.id === a.id
                      ? `${a.originalName} (닫기)`
                      : a.originalName}
                </button>
                <span className="flex shrink-0 items-center gap-3 text-xs text-slate-500">
                  <span className="tabular">{Math.ceil(a.size / 1024).toLocaleString('ko-KR')} KB</span>
                  <span>{fmt.date(a.createdAt as unknown as string)}</span>
                  {!readOnly ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        if (preview?.id === a.id) setPreview(null);
                        await remove.mutateAsync({ attachmentId: a.id, requestId: newRequestId() });
                        await list.refetch();
                      }}
                    >
                      삭제
                    </Button>
                  ) : null}
                </span>
              </div>

              {preview?.id === a.id ? (
                <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
                  {preview.mimeType === 'application/pdf' ? (
                    <object
                      data={preview.url}
                      type="application/pdf"
                      className="h-[70vh] w-full rounded"
                      aria-label={preview.name}
                    >
                      <p className="p-3 text-sm text-slate-600">
                        미리보기를 표시할 수 없습니다.{' '}
                        <a
                          className="text-blue-700 hover:underline"
                          href={preview.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          새 창에서 열기
                        </a>
                      </p>
                    </object>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element -- signed URL, not a static asset next/image can optimize
                    <img
                      src={preview.url}
                      alt={preview.name}
                      className="mx-auto max-h-[70vh] w-auto rounded"
                    />
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
