'use client';

import { useState } from 'react';
import { api, newRequestId } from '@/lib/trpc';
import { Button, Card, EmptyState, Field, Input, Spinner } from '@/components/ui/primitives';

/**
 * BAS-01: 품목분류 3단 체계(대분류·중분류·소분류) 관리.
 *
 * 품목은 최하위(3단계, 소분류)에만 등록할 수 있고, 이미 품목이 등록된 분류 아래에는 하위 분류를
 * 만들 수 없다 — 두 규칙 모두 서버가 강제하므로 화면은 선택한 단계에 맞는 등록만 노출한다.
 */
interface CategoryRow {
  id: string;
  code: string;
  name: string;
  level: number;
  parentId: string | null;
  isActive: boolean;
  sortOrder: number;
}

const byOrder = (a: CategoryRow, b: CategoryRow) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code);

export default function ItemCategoryPage() {
  const utils = api.useUtils();
  const categories = api.master.itemCategories.useQuery();
  const create = api.master.createItemCategory.useMutation({
    onSuccess: () => utils.master.itemCategories.invalidate(),
  });

  const [selectedL1, setSelectedL1] = useState<string | null>(null);
  const [selectedL2, setSelectedL2] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = (categories.data ?? []) as CategoryRow[];
  const level1 = rows.filter((c) => c.level === 1).sort(byOrder);
  const level2 = rows.filter((c) => c.level === 2 && c.parentId === selectedL1).sort(byOrder);
  const level3 = rows.filter((c) => c.level === 3 && c.parentId === selectedL2).sort(byOrder);

  async function addCategory(
    parentId: string | undefined,
    code: string,
    name: string,
    sortOrder: string,
  ): Promise<boolean> {
    setError(null);
    try {
      await create.mutateAsync({
        code: code.trim(),
        name: name.trim(),
        ...(parentId ? { parentId } : {}),
        ...(sortOrder ? { sortOrder: Number(sortOrder) } : {}),
        requestId: newRequestId(),
      });
      return true;
    } catch (err) {
      setError((err as { message?: string }).message ?? '저장에 실패했습니다.');
      return false;
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">품목분류</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          대분류 → 중분류 → 소분류 3단계로 구성됩니다. 품목은 소분류(최하위)에만 등록할 수 있습니다.
        </p>
      </header>

      {error ? (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {categories.isLoading ? (
        <Spinner />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <CategoryColumn
            idPrefix="l1"
            title="대분류"
            nodes={level1}
            selectable
            selectedId={selectedL1}
            onSelect={(id) => {
              setSelectedL1(id);
              setSelectedL2(null);
            }}
            onAdd={(code, name, sortOrder) => addCategory(undefined, code, name, sortOrder)}
            addLabel="대분류 추가"
          />
          <CategoryColumn
            idPrefix="l2"
            title="중분류"
            nodes={level2}
            selectable
            selectedId={selectedL2}
            onSelect={setSelectedL2}
            onAdd={
              selectedL1
                ? (code, name, sortOrder) => addCategory(selectedL1, code, name, sortOrder)
                : undefined
            }
            addLabel="중분류 추가"
            emptyHint={selectedL1 ? undefined : '왼쪽에서 대분류를 먼저 선택하세요.'}
          />
          <CategoryColumn
            idPrefix="l3"
            title="소분류 (품목 등록 가능)"
            nodes={level3}
            selectedId={null}
            onSelect={() => undefined}
            onAdd={
              selectedL2
                ? (code, name, sortOrder) => addCategory(selectedL2, code, name, sortOrder)
                : undefined
            }
            addLabel="소분류 추가"
            emptyHint={selectedL2 ? undefined : '가운데에서 중분류를 먼저 선택하세요.'}
          />
        </div>
      )}
    </div>
  );
}

function CategoryColumn({
  idPrefix,
  title,
  nodes,
  selectable = false,
  selectedId,
  onSelect,
  onAdd,
  addLabel,
  emptyHint,
}: {
  idPrefix: string;
  title: string;
  nodes: CategoryRow[];
  selectable?: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd?: (code: string, name: string, sortOrder: string) => Promise<boolean>;
  addLabel: string;
  emptyHint?: string;
}) {
  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [sortOrder, setSortOrder] = useState('');

  return (
    <Card
      title={title}
      actions={
        onAdd ? (
          <Button size="sm" onClick={() => setAdding((v) => !v)}>
            {adding ? '닫기' : '추가'}
          </Button>
        ) : undefined
      }
    >
      {!onAdd && emptyHint ? <p className="mb-2 text-xs text-slate-500">{emptyHint}</p> : null}

      {adding && onAdd ? (
        <form
          className="mb-3 flex flex-col gap-2 rounded-md border border-slate-200 p-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!code.trim() || !name.trim()) return;
            const ok = await onAdd(code, name, sortOrder);
            if (ok) {
              setCode('');
              setName('');
              setSortOrder('');
              setAdding(false);
            }
          }}
        >
          <Field label="분류코드" htmlFor={`${idPrefix}-code`} required>
            <Input
              id={`${idPrefix}-code`}
              name={`${idPrefix}-code`}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <Field label="분류명" htmlFor={`${idPrefix}-name`} required>
            <Input
              id={`${idPrefix}-name`}
              name={`${idPrefix}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="정렬순서" htmlFor={`${idPrefix}-sort`}>
            <Input
              id={`${idPrefix}-sort`}
              className="tabular text-right"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            />
          </Field>
          <div className="flex justify-end gap-1.5">
            <Button type="button" size="sm" onClick={() => setAdding(false)}>
              취소
            </Button>
            <Button type="submit" size="sm" variant="primary">
              {addLabel}
            </Button>
          </div>
        </form>
      ) : null}

      {nodes.length === 0 ? (
        <EmptyState title="등록된 분류가 없습니다." />
      ) : (
        <ul className="divide-y divide-slate-100 text-sm">
          {nodes.map((n) =>
            selectable ? (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => onSelect(n.id)}
                  className={`flex w-full items-center justify-between gap-2 px-1 py-1.5 text-left hover:bg-slate-50 ${
                    selectedId === n.id ? 'font-semibold text-blue-700' : ''
                  }`}
                >
                  <span>
                    {n.name} <span className="text-xs text-slate-400">{n.code}</span>
                  </span>
                  {!n.isActive ? <span className="text-xs text-slate-400">중지</span> : null}
                </button>
              </li>
            ) : (
              <li key={n.id} className="flex items-center justify-between gap-2 px-1 py-1.5">
                <span>
                  {n.name} <span className="text-xs text-slate-400">{n.code}</span>
                </span>
                {!n.isActive ? <span className="text-xs text-slate-400">중지</span> : null}
              </li>
            ),
          )}
        </ul>
      )}
    </Card>
  );
}
