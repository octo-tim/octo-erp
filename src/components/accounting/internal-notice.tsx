/**
 * The RFP requires every accounting screen and export to say plainly that these are
 * internal management figures, not filed financial statements. One component so the
 * wording is identical everywhere and cannot drift screen by screen.
 */
export function InternalNotice({ className = '' }: { className?: string }) {
  return (
    <p
      role="note"
      className={`rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 ${className}`}
    >
      내부 관리용이며 세무신고·외부공시용 확정 재무제표가 아닙니다.
    </p>
  );
}
