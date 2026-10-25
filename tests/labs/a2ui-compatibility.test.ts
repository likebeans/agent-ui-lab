import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  A2UI_BASIC_CATALOG_ID,
  A2UI_VERSION,
  a2uiMessagesSchema,
  applyA2uiMessages,
  type A2uiSurface,
} from '../../shared/a2ui';
import { readPointer, writePointer, type JsonValue } from '../../shared/json-pointer';
import type {
  ActionEnvelope,
  CompatibilityEngine,
  CompatibilityReply,
  CompatibilitySnapshot,
  DraftState,
} from '../../shared/labs/a2ui-compatibility/contract';
import {
  DEFAULT_CAPABILITIES,
  buildActionEnvelope,
  checkCompatibility,
  createDraft,
  rebaseDraft,
  resolveDraftConflict,
  trackDraftSubmission,
  updateDraft,
  validateFields,
} from '../../shared/labs/a2ui-compatibility/draft';
import { createCompatibilityEngine } from '../../shared/labs/a2ui-compatibility/engine';
import { createA2uiCompatibilityStaticHandler } from '../../shared/labs/a2ui-compatibility/static';
import { installA2uiCompatibilityRoutes } from '../../server/labs/a2ui-compatibility';
import { readCompatibilityReply } from '../../shared/labs/a2ui-compatibility/response';
import { staticFetch } from '../../shared/static-api';

const root = '/api/labs/a2ui-compatibility/documents';
const timestamp = '2026-10-24T06:00:00.000Z';

afterEach(() => vi.unstubAllGlobals());

function getSnapshot(reply: CompatibilityReply): CompatibilitySnapshot {
  if (!('snapshot' in reply)) throw new Error(`Expected snapshot, received ${reply.kind}`);
  return reply.snapshot;
}

function create(engine = createCompatibilityEngine(), documentId = 'trip'): CompatibilitySnapshot {
  return getSnapshot(engine.create({ documentId, scenario: 'standard' }));
}

function surface(snapshot: CompatibilitySnapshot): A2uiSurface {
  return applyA2uiMessages(null, snapshot.messages)!;
}

function field(state: DraftState, path: string): JsonValue | undefined {
  return readPointer(state.surface.model, path);
}

function validDraft(snapshot: CompatibilitySnapshot): DraftState {
  return updateDraft(createDraft(snapshot), '/form/traveler', '小林');
}

function action(snapshot: CompatibilitySnapshot): ActionEnvelope {
  const envelope = buildActionEnvelope(validDraft(snapshot));
  envelope.action.action.timestamp = timestamp;
  return envelope;
}

function remote(
  engine: CompatibilityEngine,
  previous: CompatibilitySnapshot,
  change: 'extend-days' | 'add-budget' | 'replace-surface' = 'extend-days',
): CompatibilitySnapshot {
  return getSnapshot(
    engine.change(previous.documentId, { expectedRevision: previous.revision, change }),
  );
}

function revised(
  snapshot: CompatibilitySnapshot,
  revise: (surface: A2uiSurface, snapshot: CompatibilitySnapshot) => void,
): CompatibilitySnapshot {
  const next = structuredClone(snapshot);
  const current = surface(next);
  next.revision += 1;
  revise(current, next);
  next.messages = [
    {
      version: A2UI_VERSION,
      createSurface: { surfaceId: next.surfaceId, catalogId: current.catalogId },
    },
    {
      version: A2UI_VERSION,
      updateDataModel: { surfaceId: next.surfaceId, path: '/', value: current.model },
    },
    {
      version: A2UI_VERSION,
      updateComponents: {
        surfaceId: next.surfaceId,
        components: Object.values(current.components),
      },
    },
  ];
  return next;
}

function moveDays(
  snapshot: CompatibilitySnapshot,
  path = '/travel/duration',
): CompatibilitySnapshot {
  return revised(snapshot, (current, next) => {
    const days = current.components.days;
    const submit = current.components.submit;
    if (days.component !== 'TextField' || submit.component !== 'Button')
      throw new Error('Invalid fixture');
    delete (current.model.form as Record<string, JsonValue>).days;
    current.model = writePointer(current.model, path, '3');
    days.value.path = path;
    submit.action.event.context.days.path = path;
    next.rules.find((rule) => rule.componentId === 'days')!.path = path;
  });
}

function removeDays(snapshot: CompatibilitySnapshot): CompatibilitySnapshot {
  return revised(snapshot, (current, next) => {
    const form = current.components.form;
    const submit = current.components.submit;
    if (form.component !== 'Column' || submit.component !== 'Button')
      throw new Error('Invalid fixture');
    delete (current.model.form as Record<string, JsonValue>).days;
    delete current.components.days;
    delete submit.action.event.context.days;
    form.children = form.children.filter((id) => id !== 'days');
    next.rules = next.rules.filter((rule) => rule.componentId !== 'days');
  });
}

function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.values(value).forEach(freeze);
  Object.freeze(value);
}

describe('A2UI compatibility authority', () => {
  it('keeps documents and engine instances isolated and returns only full protocol snapshots', () => {
    const first = createCompatibilityEngine();
    const second = createCompatibilityEngine();
    const initial = create(first, 'shared');
    const other = create(first, 'other');
    const independent = create(second, 'shared');
    expect(initial.surfaceId).not.toBe(other.surfaceId);
    expect(initial.revision).toBe(1);
    expect(initial.acceptedActions).toBe(0);
    const original = structuredClone(initial);
    (initial.messages as unknown[]).push({ malicious: true });
    initial.rules[0].path = '/bad';
    expect(getSnapshot(first.read('shared'))).toEqual(original);

    const accepted = first.act('shared', action(original));
    expect(accepted.kind).toBe('accepted');
    const next = getSnapshot(accepted);
    expect(next).toMatchObject({ revision: 2, acceptedActions: 1 });
    expect(a2uiMessagesSchema.safeParse(next.messages).success).toBe(true);
    expect(surface(next).model.result).toMatchObject({ status: expect.stringContaining('小林') });
    expect(surface(next).model.form).toMatchObject({ traveler: '小林' });
    expect(next.messages).toHaveLength(3);
    expect(JSON.stringify(next.messages)).not.toContain('expectedRevision');
    expect(getSnapshot(second.read('shared'))).toEqual(independent);
    expect(getSnapshot(first.read('other'))).toEqual(other);
  });

  it.each([
    '',
    ' with-space',
    'a/b',
    '..',
    '__proto__',
    'constructor',
    'prototype',
    'a'.repeat(65),
    'trip\n',
  ])('rejects invalid document ID %j on every engine entry point', (documentId) => {
    const engine = createCompatibilityEngine();
    expect(engine.create({ documentId, scenario: 'standard' }).kind).toBe('invalid');
    expect(engine.read(documentId).kind).toBe('invalid');
    expect(engine.change(documentId, {}).kind).toBe('invalid');
    expect(engine.act(documentId, {}).kind).toBe('invalid');
  });

  it('rejects malformed create/change requests, duplicates and missing documents without mutation', () => {
    const engine = createCompatibilityEngine();
    const initial = create(engine);
    expect(engine.create({ documentId: 'new', scenario: 'standard', extra: true }).kind).toBe(
      'invalid',
    );
    expect(engine.create({ documentId: 'new', scenario: 'arbitrary' }).kind).toBe('invalid');
    expect(engine.create({ documentId: 'new' }).kind).toBe('invalid');
    expect(engine.create({ documentId: 'trip', scenario: 'unknown-catalog' })).toMatchObject({
      kind: 'conflict',
      code: 'document-exists',
      snapshot: initial,
    });
    for (const input of [
      null,
      {},
      { expectedRevision: 1, change: 'other' },
      { expectedRevision: 1, change: 'extend-days', days: 6 },
    ]) {
      expect(engine.change('trip', input).kind).toBe('invalid');
    }
    expect(engine.change('trip', { expectedRevision: 2, change: 'extend-days' })).toMatchObject({
      kind: 'conflict',
      code: 'revision-mismatch',
    });
    expect(engine.read('missing').kind).toBe('not-found');
    expect(engine.act('missing', {}).kind).toBe('not-found');
    expect(engine.change('missing', {}).kind).toBe('not-found');
    expect(getSnapshot(engine.read('trip'))).toEqual(initial);
  });

  it('caps authoritative days at seven and adds the budget field and bindings once', () => {
    const engine = createCompatibilityEngine();
    let current = create(engine);
    for (let index = 0; index < 8; index += 1) current = remote(engine, current);
    expect(surface(current).model.form).toHaveProperty('days', '7');
    expect(current).toMatchObject({ revision: 9, acceptedActions: 0 });
    current = remote(engine, current, 'add-budget');
    const again = remote(engine, current, 'add-budget');
    expect(surface(again).components).toMatchObject({
      budget: { component: 'TextField', value: { path: '/form/budget' } },
      submit: { action: { event: { context: { budget: { path: '/form/budget' } } } } },
    });
    expect(again.rules.filter((rule) => rule.componentId === 'budget')).toHaveLength(1);
    const form = surface(again).components.form;
    expect(form.component === 'Column' && form.children.filter((id) => id === 'budget')).toEqual([
      'budget',
    ]);
    expect(surface(again).model.form).toHaveProperty('budget', '3000');
  });

  it('rejects stale revisions and replaced/other surfaces without accepting or incrementing', () => {
    const engine = createCompatibilityEngine();
    const initial = create(engine);
    const old = action(initial);
    const changed = remote(engine, initial);
    expect(engine.act('trip', old)).toMatchObject({
      kind: 'conflict',
      code: 'revision-mismatch',
      snapshot: changed,
    });
    const replaced = remote(engine, changed, 'replace-surface');
    expect(replaced.surfaceId).not.toBe(changed.surfaceId);
    expect(engine.act('trip', { ...old, expectedRevision: replaced.revision })).toMatchObject({
      kind: 'conflict',
      code: 'surface-mismatch',
    });
    const other = create(engine, 'another');
    expect(
      engine.act('trip', { ...action(other), expectedRevision: replaced.revision }),
    ).toMatchObject({ kind: 'conflict', code: 'surface-mismatch' });
    expect(getSnapshot(engine.read('trip'))).toEqual(replaced);
    const accepted = engine.act('trip', action(replaced));
    expect(accepted).toMatchObject({
      kind: 'accepted',
      snapshot: { revision: replaced.revision + 1, acceptedActions: 1 },
    });
    expect(engine.act('trip', action(replaced))).toMatchObject({
      kind: 'conflict',
      code: 'revision-mismatch',
    });
    expect(getSnapshot(engine.read('trip')).acceptedActions).toBe(1);
  });

  const badActions: [string, (envelope: ActionEnvelope) => unknown][] = [
    ['extra envelope key', (value) => ({ ...value, extra: true })],
    ['extra protocol key', (value) => ({ ...value, action: { ...value.action, revision: 1 } })],
    [
      'legacy userAction',
      () => ({ expectedRevision: 1, action: { version: A2UI_VERSION, userAction: {} } }),
    ],
    [
      'extra action key',
      (value) => ({
        ...value,
        action: { ...value.action, action: { ...value.action.action, forged: true } },
      }),
    ],
    [
      'unknown source',
      (value) => {
        value.action.action.sourceComponentId = 'traveler';
        return value;
      },
    ],
    [
      'unknown event',
      (value) => {
        value.action.action.name = 'execute';
        return value;
      },
    ],
    [
      'noncanonical source',
      (value) => {
        value.action.action.sourceComponentId = ' submit ';
        return value;
      },
    ],
    [
      'noncanonical context',
      (value) => {
        value.action.action.context['days '] = value.action.action.context.days;
        delete value.action.action.context.days;
        return value;
      },
    ],
    [
      'extra context',
      (value) => {
        value.action.action.context.budget = '3000';
        return value;
      },
    ],
    [
      'missing context',
      (value) => {
        delete value.action.action.context.days;
        return value;
      },
    ],
    [
      'invalid timestamp',
      (value) => {
        value.action.action.timestamp = 'yesterday';
        return value;
      },
    ],
    ['fractional revision', (value) => ({ ...value, expectedRevision: 1.5 })],
    [
      'blank traveler',
      (value) => {
        value.action.action.context.traveler = '  ';
        return value;
      },
    ],
    [
      'long traveler',
      (value) => {
        value.action.action.context.traveler = 'a'.repeat(41);
        return value;
      },
    ],
    [
      'invalid days',
      (value) => {
        value.action.action.context.days = '08';
        return value;
      },
    ],
    [
      'numeric days',
      (value) => {
        value.action.action.context.days = 3;
        return value;
      },
    ],
    [
      'object traveler',
      (value) => {
        value.action.action.context.traveler = { injected: 'value' };
        return value;
      },
    ],
    [
      'unknown destination',
      (value) => {
        value.action.action.context.destination = ['unknown'];
        return value;
      },
    ],
    [
      'empty destination',
      (value) => {
        value.action.action.context.destination = [];
        return value;
      },
    ],
  ];
  it.each(badActions)('rejects %s without changing authority', (_name, mutate) => {
    const engine = createCompatibilityEngine();
    const initial = create(engine);
    expect(engine.act('trip', mutate(action(initial))).kind).toBe('invalid');
    expect(getSnapshot(engine.read('trip'))).toEqual(initial);
  });

  it('distinguishes dynamic field syntax from server business validation', () => {
    const engine = createCompatibilityEngine();
    const initial = create(engine);
    const oldAction = action(initial);
    const withBudget = remote(engine, initial, 'add-budget');
    expect(engine.act('trip', { ...oldAction, expectedRevision: withBudget.revision }).kind).toBe(
      'invalid',
    );
    const draft = validDraft(withBudget);
    for (const value of ['', '0', '-1', '01', '1.5', '1e3', '10000000', '1000\n', 2000]) {
      const invalid = updateDraft(draft, '/form/budget', value);
      expect(validateFields(invalid.surface, invalid.snapshot.rules)).toContainEqual(
        expect.objectContaining({ componentId: 'budget', layer: 'client' }),
      );
      expect(() => buildActionEnvelope(invalid)).toThrow();
      const bypass = action(withBudget);
      bypass.action.action.context.budget = value;
      expect(engine.act('trip', bypass)).toMatchObject({
        kind: 'invalid',
        issues: [expect.objectContaining({ componentId: 'budget', layer: 'server' })],
      });
    }
    const low = updateDraft(draft, '/form/budget', '999');
    expect(validateFields(low.surface, low.snapshot.rules)).toEqual([]);
    expect(engine.act('trip', buildActionEnvelope(low))).toMatchObject({
      kind: 'invalid',
      issues: [
        {
          componentId: 'budget',
          path: '/form/budget',
          layer: 'server',
          message: expect.stringContaining('1000'),
        },
      ],
    });
    expect(getSnapshot(engine.read('trip'))).toEqual(withBudget);
    expect(
      engine.act('trip', buildActionEnvelope(updateDraft(draft, '/form/budget', '1000'))),
    ).toMatchObject({
      kind: 'accepted',
      snapshot: { revision: withBudget.revision + 1, acceptedActions: 1 },
    });
  });
});

describe('capability negotiation and draft reconciliation', () => {
  it('refuses unknown catalogs/components before rendering and never fetches catalog URLs', () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('Network forbidden');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const engine = createCompatibilityEngine();
    for (const scenario of ['unknown-catalog', 'unknown-component'] as const) {
      const snapshot = getSnapshot(engine.create({ documentId: scenario, scenario }));
      freeze(snapshot);
      const result = checkCompatibility(snapshot);
      expect(result).toMatchObject({
        status: 'fallback',
        text: snapshot.fallbackText,
        reasons: expect.arrayContaining([
          expect.stringContaining(scenario === 'unknown-catalog' ? 'catalog' : 'WeatherMap'),
        ]),
      });
      expect(snapshot.fallbackText).toContain('杭州 2 天');
      expect(() => createDraft(snapshot)).toThrow(snapshot.fallbackText);
      expect(
        checkCompatibility(snapshot, {
          catalogIds: [
            ...DEFAULT_CAPABILITIES.catalogIds,
            'https://example.invalid/a2ui/extended-catalog.json',
          ],
          components: [
            ...DEFAULT_CAPABILITIES.components,
            'WeatherMap',
          ] as typeof DEFAULT_CAPABILITIES.components,
        }).status,
      ).toBe('fallback');
    }
    const standard = create(engine);
    expect(checkCompatibility(standard, { ...DEFAULT_CAPABILITIES, catalogIds: [] }).status).toBe(
      'fallback',
    );
    expect(
      checkCompatibility(standard, {
        ...DEFAULT_CAPABILITIES,
        components: ['Card', 'Column', 'Text'],
      }).status,
    ).toBe('fallback');
    expect(checkCompatibility(standard)).toMatchObject({ status: 'ready' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses malformed protocol messages and mismatched or incomplete surfaces', () => {
    const initial = create();
    const malformed = structuredClone(initial);
    (malformed.messages[0] as Record<string, unknown>).revision = 2;
    expect(checkCompatibility(malformed).status).toBe('fallback');
    expect(checkCompatibility({ ...initial, surfaceId: 'other' }).status).toBe('fallback');
    expect(checkCompatibility({ ...initial, messages: initial.messages.slice(0, 1) }).status).toBe(
      'fallback',
    );
    const broken = revised(initial, (current) => {
      current.components.root = { id: 'root', component: 'Card', child: 'missing' };
    });
    expect(checkCompatibility(broken).status).toBe('fallback');
    expect(DEFAULT_CAPABILITIES.catalogIds).toEqual([A2UI_BASIC_CATALOG_ID]);
    expect(DEFAULT_CAPABILITIES.components).toHaveLength(6);
  });

  it('preserves frozen messages, base model and every earlier draft during edits, rebase and resolution', () => {
    const engine = createCompatibilityEngine();
    const initial = create(engine);
    const original = structuredClone(initial);
    freeze(initial);
    const clean = createDraft(initial);
    freeze(clean);
    const edited = updateDraft(updateDraft(clean, '/form/traveler', '小林'), '/form/days', '5');
    freeze(edited);
    const updated = remote(engine, initial);
    freeze(updated);
    const rebased = rebaseDraft(edited, updated);
    freeze(rebased);
    const resolved = resolveDraftConflict(rebased, '/form/days', 'local');
    expect(field(resolved, '/form/days')).toBe('5');
    expect(field(clean, '/form/days')).toBe('2');
    expect(edited.conflicts).toEqual([]);
    expect(rebased.conflicts).toHaveLength(1);
    expect(initial).toEqual(original);
    expect(readPointer(resolved.base.model, '/form/days')).toBe('3');
    const payload = buildActionEnvelope(resolved);
    payload.action.action.context.destination = ['chengdu'];
    expect(field(resolved, '/form/destination')).toEqual(['hangzhou']);
  });

  it('applies clean remote edits while preserving local edits and adding live rules', () => {
    const engine = createCompatibilityEngine();
    const initial = create(engine);
    const draft = validDraft(initial);
    const changed = remote(engine, initial);
    const rebased = rebaseDraft(draft, changed);
    expect(field(rebased, '/form/traveler')).toBe('小林');
    expect(field(rebased, '/form/days')).toBe('3');
    expect(rebased.conflicts).toEqual([]);
    const budget = remote(engine, changed, 'add-budget');
    const withBudget = rebaseDraft(rebased, budget);
    expect(field(withBudget, '/form/budget')).toBe('3000');
    expect(buildActionEnvelope(withBudget)).toMatchObject({
      expectedRevision: budget.revision,
      action: { action: { context: { traveler: '小林', days: '3', budget: '3000' } } },
    });
    const replaced = remote(engine, budget, 'replace-surface');
    const fresh = rebaseDraft(withBudget, replaced);
    expect(fresh.surface.surfaceId).toBe(replaced.surfaceId);
    expect(buildActionEnvelope(fresh).action.action.surfaceId).toBe(replaced.surfaceId);
    expect(field(fresh, '/form/traveler')).toBe('小林');
  });

  it.each(['local', 'remote'] as const)(
    'protects an edit back to the original value after a lost reply until choosing %s',
    (decision) => {
      const engine = createCompatibilityEngine();
      const initial = create(engine);
      const saved = updateDraft(validDraft(initial), '/form/days', '3');
      const edited = updateDraft(saved, '/form/days', '2');
      freeze(edited);
      const pending = trackDraftSubmission(edited, saved.surface);
      // The engine executes, but the caller never receives its acknowledgement.
      engine.act('trip', buildActionEnvelope(saved));
      expect(rebaseDraft(pending, initial)).toBe(pending);
      const latest = getSnapshot(engine.read('trip'));
      const rebased = rebaseDraft(pending, latest);
      expect(latest).toMatchObject({ revision: 2, acceptedActions: 1 });
      expect(field(rebased, '/form/days')).toBe('2');
      expect(rebased.conflicts).toMatchObject([
        { componentId: 'days', base: '2', local: '2', remote: '3' },
      ]);
      expect(() => buildActionEnvelope(rebased)).toThrow('冲突');
      const resolved = resolveDraftConflict(rebased, '/form/days', decision);
      expect(buildActionEnvelope(resolved).action.action.context.days).toBe(
        decision === 'local' ? '2' : '3',
      );
      expect(resolved.unconfirmedEdits).toBeUndefined();
      expect(edited.conflicts).toEqual([]);
    },
  );

  it('does not attribute another accepted action to a submission with an unknown outcome', () => {
    const engine = createCompatibilityEngine();
    const initial = create(engine);
    const saved = updateDraft(validDraft(initial), '/form/days', '3');
    const local = updateDraft(saved, '/form/days', '5');
    const pending = trackDraftSubmission(local, saved.surface);
    // Another client saves the original days value at the expected revision.
    engine.act('trip', action(initial));
    const latest = getSnapshot(engine.read('trip'));
    expect(latest).toMatchObject({ revision: 2, acceptedActions: 1 });
    const rebased = rebaseDraft(pending, latest);
    expect(field(rebased, '/form/days')).toBe('5');
    expect(rebased.conflicts).toMatchObject([{ base: '2', local: '5', remote: '2' }]);
  });

  it('protects edits made after a lost reply and keeps them through Surface replacement', () => {
    const engine = createCompatibilityEngine();
    const initial = create(engine);
    const submitted = updateDraft(validDraft(initial), '/form/days', '3');
    const pending = trackDraftSubmission(submitted, submitted.surface);
    const latest = getSnapshot(engine.act('trip', buildActionEnvelope(submitted)));
    const edited = updateDraft(pending, '/form/days', '2');
    const replaced = remote(engine, latest, 'replace-surface');
    const rebased = rebaseDraft(edited, replaced);
    expect(field(rebased, '/form/days')).toBe('2');
    expect(rebased.surface.surfaceId).toBe(replaced.surfaceId);
    expect(rebased.conflicts).toMatchObject([{ local: '2', remote: '3' }]);
  });

  it.each(['local', 'remote'] as const)(
    'resolves a dirty conflict explicitly using %s',
    (decision) => {
      const engine = createCompatibilityEngine();
      const initial = create(engine);
      const draft = updateDraft(validDraft(initial), '/form/days', '5');
      const changed = remote(engine, initial);
      const rebased = rebaseDraft(draft, changed);
      expect(field(rebased, '/form/days')).toBe('5');
      expect(rebased.conflicts).toEqual([
        {
          componentId: 'days',
          label: '行程天数',
          path: '/form/days',
          base: '2',
          local: '5',
          remote: '3',
        },
      ]);
      expect(() => buildActionEnvelope(rebased)).toThrow('冲突');
      const resolved = resolveDraftConflict(rebased, '/form/days', decision);
      expect(resolved.conflicts).toEqual([]);
      expect(buildActionEnvelope(resolved)).toMatchObject({
        expectedRevision: changed.revision,
        action: { action: { context: { days: decision === 'local' ? '5' : '3' } } },
      });
      expect(engine.act('trip', buildActionEnvelope(resolved)).kind).toBe('accepted');
    },
  );

  it('retains unresolved conflicts across repeated remote updates, local edits and delayed replies', () => {
    const engine = createCompatibilityEngine();
    const initial = create(engine);
    const draft = updateDraft(validDraft(initial), '/form/days', '5');
    const three = remote(engine, initial);
    const first = rebaseDraft(draft, three);
    const four = remote(engine, three);
    const second = rebaseDraft(first, four);
    expect(second.conflicts).toMatchObject([{ base: '2', local: '5', remote: '4' }]);
    expect(rebaseDraft(second, three)).toBe(second);
    expect(rebaseDraft(second, four)).toBe(second);
    const edited = updateDraft(second, '/form/days', '6');
    expect(edited.conflicts[0].local).toBe('6');
    const five = remote(engine, four);
    const third = rebaseDraft(edited, five);
    const six = remote(engine, five);
    const equal = rebaseDraft(third, six);
    expect(equal.conflicts).toMatchObject([{ base: '2', local: '6', remote: '6' }]);
    expect(() => buildActionEnvelope(equal)).toThrow('冲突');
    expect(field(resolveDraftConflict(equal, '/form/days', 'remote'), '/form/days')).toBe('6');
    expect(() => rebaseDraft(equal, { ...six, documentId: 'other', revision: 99 })).toThrow(
      '其他文档',
    );
  });

  it('keeps pending conflicts when authority returns to its original value', () => {
    const initial = create();
    const draft = updateDraft(validDraft(initial), '/form/days', '5');
    const changed = revised(initial, (current) => {
      current.model = writePointer(current.model, '/form/days', '3');
    });
    const pending = rebaseDraft(draft, changed);
    const reverted = revised(changed, (current) => {
      current.model = writePointer(current.model, '/form/days', '2');
    });
    const rebased = rebaseDraft(pending, reverted);
    expect(rebased.conflicts).toMatchObject([{ base: '2', local: '5', remote: '2' }]);
  });

  it('does not conflict when a fresh remote update independently matches the local edit', () => {
    const engine = createCompatibilityEngine();
    const initial = create(engine);
    const draft = updateDraft(validDraft(initial), '/form/days', '3');
    const rebased = rebaseDraft(draft, remote(engine, initial));
    expect(rebased.conflicts).toEqual([]);
    expect(field(rebased, '/form/days')).toBe('3');
  });

  it.each(['local', 'remote'] as const)(
    'records moved binding paths and resolves to the current path using %s',
    (decision) => {
      const initial = create();
      const draft = updateDraft(validDraft(initial), '/form/days', '5');
      const moved = moveDays(initial);
      const rebased = rebaseDraft(draft, moved);
      expect(rebased.conflicts).toMatchObject([
        { path: '/form/days', base: '2', local: '5', remote: '3' },
      ]);
      expect(field(rebased, '/form/days')).toBe('5');
      expect(() => buildActionEnvelope(rebased)).toThrow('冲突');
      const latest = revised(moved, (current) => {
        current.model = writePointer(current.model, '/travel/duration', '4');
      });
      const pending = rebaseDraft(rebased, latest);
      expect(pending.conflicts).toMatchObject([{ path: '/form/days', local: '5', remote: '4' }]);
      const resolved = resolveDraftConflict(pending, '/form/days', decision);
      expect(field(resolved, '/form/days')).toBeUndefined();
      expect(field(resolved, '/travel/duration')).toBe(decision === 'local' ? '5' : '4');
      expect(buildActionEnvelope(resolved).action.action.context.days).toBe(
        decision === 'local' ? '5' : '4',
      );
    },
  );

  it('tracks new edits to moved fields through subsequent remote updates', () => {
    const initial = create();
    const draft = updateDraft(validDraft(initial), '/form/days', '5');
    const moved = moveDays(initial);
    const rebased = rebaseDraft(draft, moved);
    expect(field(rebased, '/travel/duration')).toBe('5');
    const edited = updateDraft(rebased, '/travel/duration', '6');
    expect(edited.conflicts).toMatchObject([{ path: '/form/days', local: '6' }]);
    expect(field(edited, '/form/days')).toBe('6');
    const latest = revised(moved, (current) => {
      current.model = writePointer(current.model, '/travel/duration', '4');
    });
    const pending = rebaseDraft(edited, latest);
    expect(pending.conflicts).toHaveLength(1);
    expect(pending.conflicts[0]).toMatchObject({ base: '2', local: '6', remote: '4' });
    expect(field(pending, '/travel/duration')).toBe('6');
    expect(
      buildActionEnvelope(resolveDraftConflict(pending, '/form/days', 'local')).action.action
        .context.days,
    ).toBe('6');
    expect(
      buildActionEnvelope(resolveDraftConflict(pending, '/form/days', 'remote')).action.action
        .context.days,
    ).toBe('4');
  });

  it.each(['local', 'remote'] as const)(
    'records removed bindings without leaking them into action context using %s',
    (decision) => {
      const initial = create();
      const draft = updateDraft(validDraft(initial), '/form/days', '5');
      const removed = removeDays(initial);
      const pending = rebaseDraft(draft, removed);
      expect(pending.conflicts).toMatchObject([
        { path: '/form/days', base: '2', local: '5', remote: undefined },
      ]);
      expect(field(pending, '/form/days')).toBe('5');
      const latest = revised(removed, (current) => {
        current.model = writePointer(current.model, '/result/status', '远端再次更新');
      });
      const rebased = rebaseDraft(pending, latest);
      expect(rebased.conflicts).toHaveLength(1);
      const resolved = resolveDraftConflict(rebased, '/form/days', decision);
      expect(field(resolved, '/form/days')).toBe(decision === 'local' ? '5' : undefined);
      expect(buildActionEnvelope(resolved).action.action.context).not.toHaveProperty('days');
    },
  );

  it('retains locally resolved removed values across later unrelated remote updates', () => {
    const initial = create();
    const draft = updateDraft(validDraft(initial), '/form/days', '5');
    const removed = removeDays(initial);
    const resolved = resolveDraftConflict(rebaseDraft(draft, removed), '/form/days', 'local');
    freeze(resolved);
    const latest = revised(removed, (current) => {
      current.model = writePointer(current.model, '/result/status', '后续远端更新');
    });
    const rebased = rebaseDraft(resolved, latest);
    expect(field(rebased, '/form/days')).toBe('5');
    expect(rebased.conflicts).toEqual([]);
    expect(buildActionEnvelope(rebased).action.action.context).not.toHaveProperty('days');
    const again = rebaseDraft(
      rebased,
      revised(latest, () => {}),
    );
    expect(field(again, '/form/days')).toBe('5');
    expect(again.conflicts).toEqual([]);
  });

  it('keeps historic values out of action context bound to their ancestor object', () => {
    const initial = create();
    const draft = updateDraft(validDraft(initial), '/form/days', '5');
    const removed = revised(removeDays(initial), (current) => {
      const submit = current.components.submit;
      if (submit.component !== 'Button') throw new Error('Invalid fixture');
      submit.action.event.context.form = { path: '/form' };
    });
    const pending = rebaseDraft(draft, removed);
    expect(field(pending, '/form/days')).toBeUndefined();
    expect(pending.conflicts).toMatchObject([{ componentId: 'days', local: '5' }]);
    const resolved = resolveDraftConflict(pending, '/form/days', 'local');
    const latest = rebaseDraft(
      resolved,
      revised(removed, () => {}),
    );
    expect(latest.retainedValues).toEqual([
      { componentId: 'days', path: '/form/days', value: '5' },
    ]);
    expect(buildActionEnvelope(latest).action.action.context.form).not.toHaveProperty('days');
  });

  it('keeps retained removed values separate when their historic path is later reused', () => {
    const initial = create();
    const draft = updateDraft(validDraft(initial), '/form/days', '5');
    const removed = removeDays(initial);
    const resolved = resolveDraftConflict(rebaseDraft(draft, removed), '/form/days', 'local');
    const retained = [{ componentId: 'days', path: '/form/days', value: '5' }];
    expect(resolved.retainedValues).toEqual(retained);
    const reused = revised(removed, (current, next) => {
      const form = current.components.form;
      const submit = current.components.submit;
      if (form.component !== 'Column' || submit.component !== 'Button')
        throw new Error('Invalid fixture');
      current.model = writePointer(current.model, '/form/days', 'remote notes');
      current.components.notes = {
        id: 'notes',
        component: 'TextField',
        label: '备注',
        value: { path: '/form/days' },
      };
      form.children.push('notes');
      submit.action.event.context.notes = { path: '/form/days' };
      next.rules.push({ componentId: 'notes', path: '/form/days', label: '备注' });
    });
    const rebased = rebaseDraft(resolved, reused);
    expect(field(rebased, '/form/days')).toBe('remote notes');
    expect(rebased.retainedValues).toEqual(retained);
    freeze(rebased);
    const edited = updateDraft(rebased, '/form/days', 'local notes');
    const latest = rebaseDraft(
      edited,
      revised(reused, () => {}),
    );
    expect(field(latest, '/form/days')).toBe('local notes');
    expect(latest.retainedValues).toEqual(retained);
    expect(latest.conflicts).toEqual([]);
    expect(buildActionEnvelope(latest).action.action.context).toMatchObject({
      notes: 'local notes',
    });
    expect(buildActionEnvelope(latest).action.action.context).not.toHaveProperty('days');
    expect(field(rebased, '/form/days')).toBe('remote notes');
  });

  it.each(['local', 'remote'] as const)(
    'recovers a retained field at a new binding and resolves using %s',
    (decision) => {
      const initial = create();
      const draft = updateDraft(validDraft(initial), '/form/days', '5');
      const removed = removeDays(initial);
      const resolved = resolveDraftConflict(rebaseDraft(draft, removed), '/form/days', 'local');
      const restored = { ...moveDays(initial), revision: removed.revision + 1 };
      const pending = rebaseDraft(resolved, restored);
      expect(field(pending, '/travel/duration')).toBe('5');
      expect(pending.retainedValues).toEqual([]);
      expect(pending.conflicts).toMatchObject([
        { componentId: 'days', path: '/form/days', local: '5', remote: '3' },
      ]);
      const recovered = resolveDraftConflict(pending, '/form/days', decision);
      expect(buildActionEnvelope(recovered).action.action.context.days).toBe(
        decision === 'local' ? '5' : '3',
      );
    },
  );

  it.each(['local', 'remote'] as const)(
    'rebases a field moved below its historic path and resolves using %s',
    (decision) => {
      const initial = create();
      const draft = updateDraft(validDraft(initial), '/form/days', '5');
      const moved = moveDays(initial, '/form/days/value');
      const pending = rebaseDraft(draft, moved);
      expect(field(pending, '/form/days')).toEqual({ value: '5' });
      expect(pending.conflicts).toMatchObject([
        { componentId: 'days', path: '/form/days', base: '2', local: '5', remote: '3' },
      ]);
      const edited = updateDraft(pending, '/form/days/value', '6');
      const latest = revised(moved, (current) => {
        current.model = writePointer(current.model, '/form/days/value', '4');
      });
      const rebased = rebaseDraft(edited, latest);
      expect(field(rebased, '/form/days')).toEqual({ value: '6' });
      expect(rebased.conflicts).toMatchObject([{ path: '/form/days', local: '6', remote: '4' }]);
      const resolved = resolveDraftConflict(rebased, '/form/days', decision);
      expect(resolved.conflicts).toEqual([]);
      expect(field(resolved, '/form/days')).toEqual({ value: decision === 'local' ? '6' : '4' });
      expect(buildActionEnvelope(resolved).action.action.context.days).toBe(
        decision === 'local' ? '6' : '4',
      );
    },
  );

  it.each(['local', 'remote'] as const)(
    'rebases a field moved above its historic path and resolves using %s',
    (decision) => {
      const initial = moveDays(create(), '/form/days/value');
      const draft = updateDraft(validDraft(initial), '/form/days/value', '5');
      const moved = revised(initial, (current, next) => {
        const days = current.components.days;
        const submit = current.components.submit;
        if (days.component !== 'TextField' || submit.component !== 'Button')
          throw new Error('Invalid fixture');
        current.model = writePointer(current.model, '/form/days', '4');
        days.value.path = '/form/days';
        submit.action.event.context.days.path = '/form/days';
        next.rules.find((rule) => rule.componentId === 'days')!.path = '/form/days';
      });
      const pending = rebaseDraft(draft, moved);
      expect(field(pending, '/form/days')).toBe('5');
      expect(pending.conflicts).toMatchObject([
        { componentId: 'days', path: '/form/days/value', local: '5', remote: '4' },
      ]);
      const edited = updateDraft(pending, '/form/days', '6');
      expect(() => updateDraft(edited, '/form/days/value', '7')).toThrow('可编辑');
      const latest = revised(moved, (current) => {
        current.model = writePointer(current.model, '/form/days', '7');
      });
      const rebased = rebaseDraft(edited, latest);
      const resolved = resolveDraftConflict(rebased, '/form/days/value', decision);
      expect(field(resolved, '/form/days')).toBe(decision === 'local' ? '6' : '7');
      expect(buildActionEnvelope(resolved).action.action.context.days).toBe(
        decision === 'local' ? '6' : '7',
      );
    },
  );

  it.each(['local', 'remote'] as const)(
    'keeps a new field at a moved binding historic path independent using %s',
    (decision) => {
      const initial = create();
      const draft = updateDraft(validDraft(initial), '/form/days', '5');
      const moved = revised(moveDays(initial), (current, next) => {
        const form = current.components.form;
        const submit = current.components.submit;
        if (form.component !== 'Column' || submit.component !== 'Button')
          throw new Error('Invalid fixture');
        current.model = writePointer(current.model, '/form/days', 'new remote value');
        current.components.notes = {
          id: 'notes',
          component: 'TextField',
          label: '备注',
          value: { path: '/form/days' },
        };
        form.children.push('notes');
        submit.action.event.context.notes = { path: '/form/days' };
        next.rules.push({ componentId: 'notes', path: '/form/days', label: '备注' });
      });
      const pending = rebaseDraft(draft, moved);
      expect(field(pending, '/form/days')).toBe('new remote value');
      expect(field(pending, '/travel/duration')).toBe('5');
      const editedNew = updateDraft(pending, '/form/days', 'new local value');
      expect(editedNew.conflicts).toMatchObject([
        { componentId: 'days', path: '/form/days', local: '5' },
      ]);
      const editedOld = updateDraft(editedNew, '/travel/duration', '6');
      expect(field(editedOld, '/form/days')).toBe('new local value');
      expect(editedOld.conflicts).toMatchObject([{ componentId: 'days', local: '6' }]);
      const latest = revised(moved, (current) => {
        current.model = writePointer(current.model, '/travel/duration', '4');
      });
      const rebased = rebaseDraft(editedOld, latest);
      expect(rebased.conflicts).toHaveLength(1);
      expect(rebased.conflicts).toMatchObject([{ componentId: 'days', local: '6', remote: '4' }]);
      expect(field(rebased, '/form/days')).toBe('new local value');
      const resolved = resolveDraftConflict(rebased, '/form/days', decision);
      expect(field(resolved, '/form/days')).toBe('new local value');
      expect(buildActionEnvelope(resolved).action.action.context).toMatchObject({
        days: decision === 'local' ? '6' : '4',
        notes: 'new local value',
      });
    },
  );

  it('uses component-driven field validation and only allows edits to bound fields', () => {
    const initial = create();
    const draft = createDraft(initial);
    expect(validateFields(draft.surface, initial.rules)).toMatchObject([
      { componentId: 'traveler', layer: 'client' },
    ]);
    expect(() => buildActionEnvelope(draft)).toThrow('出行人');
    expect(() => updateDraft(draft, '/result/status', 'forged')).toThrow('可编辑');
    expect(() => updateDraft(draft, '/__proto__/polluted', 'yes')).toThrow();
    expect(
      validateFields(updateDraft(draft, '/form/destination', ['forged']).surface, initial.rules),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ componentId: 'destination' })]));
    const missingBinding = structuredClone(draft.surface);
    delete missingBinding.components.days;
    expect(validateFields(missingBinding, initial.rules)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ componentId: 'days', message: expect.stringContaining('绑定') }),
      ]),
    );
    expect(() => buildActionEnvelope(validDraft(initial), 'traveler')).toThrow('Button');
  });
});

function post(input: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  };
}

async function httpFixture() {
  const app = express();
  app.use(express.json());
  installA2uiCompatibilityRoutes(app);
  installA2uiCompatibilityRoutes(app);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    fetch: (path: string, options: RequestInit = {}) => fetch(`${origin}${path}`, options),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

describe('compatibility reply handling at transport boundaries', () => {
  it('uses the real static entrypoint for snapshots, invalid400, conflict409 and generic404', async () => {
    const documentId = `reply-${crypto.randomUUID()}`;
    const created = await readCompatibilityReply(
      await staticFetch(root, post({ documentId, scenario: 'standard' })),
    );
    expect(created.kind).toBe('snapshot');
    const initial = getSnapshot(created);
    const invalid = await readCompatibilityReply(
      await staticFetch(`${root}/${documentId}/actions`, post({})),
    );
    expect(invalid).toMatchObject({ kind: 'invalid', issues: [] });
    const accepted = await readCompatibilityReply(
      await staticFetch(`${root}/${documentId}/actions`, post(action(initial))),
    );
    expect(accepted).toMatchObject({ kind: 'accepted', snapshot: { acceptedActions: 1 } });
    const conflict = await readCompatibilityReply(
      await staticFetch(`${root}/${documentId}/actions`, post(action(initial))),
    );
    expect(conflict).toMatchObject({
      kind: 'conflict',
      code: 'revision-mismatch',
      snapshot: { revision: 2, acceptedActions: 1 },
    });
    await expect(
      readCompatibilityReply(await staticFetch(`${root}/${documentId}/missing-route`)),
    ).rejects.toThrow('HTTP 404：静态学习版没有此教学路由。');
    expect(
      await readCompatibilityReply(await staticFetch(`${root}/${documentId}-missing`)),
    ).toMatchObject({ kind: 'not-found', message: '文档不存在。' });
  });

  it('preserves the module rejection for malformed JSON through the full static entrypoint', async () => {
    const response = await staticFetch(root, { ...post({}), body: '{' });
    expect(response.status).toBe(400);
    expect(await readCompatibilityReply(response)).toMatchObject({
      kind: 'invalid',
      message: '请求 JSON 无效。',
      issues: [],
    });
  });

  it.each([403, 404, 500])('surfaces generic HTTP %i errors', async (status) => {
    await expect(
      readCompatibilityReply(new Response(JSON.stringify({ error: '表单请求失败。' }), { status })),
    ).rejects.toThrow(`HTTP ${status}：表单请求失败。`);
  });

  it.each([
    null,
    [],
    { kind: 'future-reply' },
    { kind: 'snapshot', snapshot: {} },
    { kind: 'accepted', snapshot: null },
    { kind: 'invalid', message: 'invalid', issues: [{}] },
  ])('rejects an unknown or incomplete JSON reply %j', async (body) => {
    await expect(readCompatibilityReply(new Response(JSON.stringify(body)))).rejects.toThrow(
      'HTTP 200：响应格式无效，无法确认应用结果。',
    );
  });

  it('rejects non-JSON and success-shaped HTTP failures without trusting their snapshots', async () => {
    await expect(
      readCompatibilityReply(new Response('<html>Unavailable</html>', { status: 500 })),
    ).rejects.toThrow('HTTP 500：响应不是有效的 JSON。');
    await expect(
      readCompatibilityReply(
        new Response(JSON.stringify({ kind: 'snapshot', snapshot: create() }), { status: 500 }),
      ),
    ).rejects.toThrow('HTTP 500：响应状态与应用结果不一致。');
  });
});

describe('HTTP and browser-memory adapters', () => {
  it('has matching routes, JSON output and statuses with independent authorities', async () => {
    const http = await httpFixture();
    const local = createA2uiCompatibilityStaticHandler();
    async function both(path: string, options: RequestInit = {}, status = 200) {
      const [live, memory] = await Promise.all([http.fetch(path, options), local(path, options)]);
      expect(live.status).toBe(status);
      expect(memory?.status).toBe(status);
      expect(memory?.headers.get('X-Lab-Transport')).toBe('browser-memory');
      const [left, right] = await Promise.all([live.json(), memory!.json()]);
      expect(left).toEqual(right);
      return left as CompatibilityReply;
    }
    try {
      const initial = getSnapshot(
        await both(root, post({ documentId: 'transport', scenario: 'standard' })),
      );
      await both(`${root}/transport`);
      await both(root, post({ documentId: 'transport', scenario: 'standard' }), 409);
      await both(`${root}/missing`, {}, 404);
      await both(`${root}/bad%20id`, {}, 400);
      await both(`${root}/%E0%A4%A`, {}, 400);
      await both(root, { ...post({}), body: '{' }, 400);
      for (const primitive of [null, false, 1, 'text']) await both(root, post(primitive), 400);
      await both(`${root}/transport/remote`, post({ expectedRevision: 1, change: 'other' }), 400);
      await both(`${root}/transport/actions`, post({ extra: true }), 400);
      const changed = getSnapshot(
        await both(`${root}/transport/remote`, post({ expectedRevision: 1, change: 'add-budget' })),
      );
      await both(`${root}/transport/actions`, post(action(initial)), 409);
      const low = action(changed);
      low.action.action.context.budget = '1';
      await both(`${root}/transport/actions`, post(low), 400);
      const accepted = getSnapshot(await both(`${root}/transport/actions`, post(action(changed))));
      expect(accepted.acceptedActions).toBe(1);
      await both(`${root}/transport/actions`, post(action(changed)), 409);
      const replacement = getSnapshot(
        await both(
          `${root}/transport/remote`,
          post({ expectedRevision: accepted.revision, change: 'replace-surface' }),
        ),
      );
      await both(
        `${root}/transport/actions`,
        post({ ...action(accepted), expectedRevision: replacement.revision }),
        409,
      );
      await http.fetch(
        `${root}/transport/remote`,
        post({ expectedRevision: replacement.revision, change: 'extend-days' }),
      );
      const localOnly = await local(`${root}/transport`, {});
      expect(await localOnly!.json()).toEqual({ kind: 'snapshot', snapshot: replacement });
      expect(
        (await http.fetch(`${root}/transport`).then((response) => response.json())).snapshot
          .revision,
      ).toBe(replacement.revision + 1);
    } finally {
      await http.close();
    }
  });

  it('isolates installed server apps and static-handler factories', async () => {
    const first = await httpFixture();
    const second = await httpFixture();
    const left = createA2uiCompatibilityStaticHandler();
    const right = createA2uiCompatibilityStaticHandler();
    try {
      expect(
        (await first.fetch(root, post({ documentId: 'one', scenario: 'standard' }))).status,
      ).toBe(200);
      expect((await second.fetch(`${root}/one`)).status).toBe(404);
      expect((await left(root, post({ documentId: 'one', scenario: 'standard' })))?.status).toBe(
        200,
      );
      expect((await right(`${root}/one`, {}))?.status).toBe(404);
      expect(await left('/api/elsewhere', {})).toBeUndefined();
      expect(await left(`${root}/one`, { method: 'DELETE' })).toBeUndefined();
      const controller = new AbortController();
      controller.abort();
      await expect(left(`${root}/one`, { signal: controller.signal })).rejects.toThrow();
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('lets two local clients observe the same authority and reconcile an accepted edit', async () => {
    const local = createA2uiCompatibilityStaticHandler();
    const initial = getSnapshot(
      await (await local(root, post({ documentId: 'clients', scenario: 'standard' })))!.json(),
    );
    const a = validDraft(initial);
    const b = updateDraft(validDraft(initial), '/form/days', '4');
    const saved = getSnapshot(
      await (await local(`${root}/clients/actions`, post(buildActionEnvelope(a))))!.json(),
    );
    const rejected = await local(`${root}/clients/actions`, post(buildActionEnvelope(b)));
    expect(rejected?.status).toBe(409);
    expect(await rejected!.json()).toMatchObject({
      kind: 'conflict',
      snapshot: { revision: saved.revision, acceptedActions: 1 },
    });
    const latest = getSnapshot(await (await local(`${root}/clients`, {}))!.json());
    const rebased = rebaseDraft(b, latest);
    expect(field(rebased, '/form/days')).toBe('4');
    const next = getSnapshot(
      await (await local(`${root}/clients/actions`, post(buildActionEnvelope(rebased))))!.json(),
    );
    expect(next).toMatchObject({ revision: saved.revision + 1, acceptedActions: 2 });
    expect(getSnapshot(await (await local(`${root}/clients`, {}))!.json())).toEqual(next);
  });
});
