import { describe, expect, it } from 'vitest';
import {
  presentActivity,
  FORMER_ROOMMATE_LABEL,
  maintenanceDetailHref,
  maintenanceSentenceParts,
} from './activity-copy.js';
import {
  activityItem,
  FIXTURE_JOINED,
  FIXTURE_LEFT,
  FIXTURE_MAINTENANCE_CREATED,
  FIXTURE_MAINTENANCE_PRIVATE,
  FIXTURE_MAINTENANCE_RESOLVED,
  FIXTURE_ROLE_CHANGED,
  FIXTURE_SUPPLY_GENERIC,
  FIXTURE_SUPPLY_TITLED,
  FIXTURE_TASK_GENERIC,
  FIXTURE_TASK_TITLED,
  SOURCE_MAINTENANCE_ID,
  SOURCE_MAINTENANCE_PRIVATE_ID,
  TEST_HOME_A,
  TEST_MEMBERSHIP_ALEX,
  TEST_MEMBERSHIP_JAMIE,
  TEST_MEMBERSHIP_TAYLOR,
} from './test-fixtures.js';

describe('Activity presentation copy', () => {
  it('renders membership.started with the subject', () => {
    expect(presentActivity(FIXTURE_JOINED).sentence).toBe(
      'Jamie joined the home',
    );
  });

  it('renders membership.ended as a leave, ignoring a different actor', () => {
    expect(presentActivity(FIXTURE_LEFT).sentence).toBe('Jamie left the home');
    expect(presentActivity(FIXTURE_LEFT).sentence).not.toMatch(
      /removed|Taylor/,
    );
  });

  it('renders membership.role_changed with distinct actor and subject', () => {
    expect(presentActivity(FIXTURE_ROLE_CHANGED).sentence).toBe(
      "Taylor updated Jamie's home role",
    );
    expect(presentActivity(FIXTURE_ROLE_CHANGED).sentence).not.toMatch(
      /promoted|demoted|Admin|Roommate/,
    );
  });

  it('renders a titled task completion', () => {
    expect(presentActivity(FIXTURE_TASK_TITLED).sentence).toBe(
      'Alex completed Take out trash',
    );
  });

  it('renders a generic task completion when the title is missing', () => {
    expect(presentActivity(FIXTURE_TASK_GENERIC).sentence).toBe(
      'Alex completed a task',
    );
  });

  it('renders a titled supply obtained event', () => {
    expect(presentActivity(FIXTURE_SUPPLY_TITLED).sentence).toBe(
      'Alex marked Paper towels obtained',
    );
  });

  it('renders a generic supply obtained event when the title is missing', () => {
    expect(presentActivity(FIXTURE_SUPPLY_GENERIC).sentence).toBe(
      'Alex marked a supply obtained',
    );
  });

  it('renders generic maintenance created copy without the source title', () => {
    expect(presentActivity(FIXTURE_MAINTENANCE_CREATED).sentence).toBe(
      'Alex added a maintenance item',
    );
    expect(presentActivity(FIXTURE_MAINTENANCE_CREATED).sentence).not.toContain(
      'Quiet leak under sink',
    );
  });

  it('renders generic maintenance resolved copy without the source title', () => {
    expect(presentActivity(FIXTURE_MAINTENANCE_RESOLVED).sentence).toBe(
      'Alex resolved a maintenance item',
    );
    expect(
      presentActivity(FIXTURE_MAINTENANCE_RESOLVED).sentence,
    ).not.toContain('Quiet leak under sink');
  });

  it('uses a named actor when present', () => {
    expect(presentActivity(FIXTURE_TASK_TITLED).sentence).toContain('Alex');
  });

  it('uses Former roommate for a null actor name', () => {
    const item = activityItem({
      actor: { membershipId: TEST_MEMBERSHIP_ALEX, name: null },
    });
    expect(presentActivity(item).sentence).toBe(
      `${FORMER_ROOMMATE_LABEL} completed Take out trash`,
    );
    expect(presentActivity(item).sentence).not.toContain(TEST_MEMBERSHIP_ALEX);
  });

  it('uses Former roommate for a null subject name', () => {
    const item = activityItem({
      eventType: 'membership.started.v1',
      sourceEntityType: 'MEMBERSHIP',
      sourceTitle: null,
      actor: null,
      subject: { membershipId: TEST_MEMBERSHIP_JAMIE, name: null },
    });
    expect(presentActivity(item).sentence).toBe(
      `${FORMER_ROOMMATE_LABEL} joined the home`,
    );
    expect(presentActivity(item).sentence).not.toContain(TEST_MEMBERSHIP_JAMIE);
  });

  it('never includes raw membership IDs in presentation', () => {
    const sentence = presentActivity(FIXTURE_LEFT).sentence;
    expect(sentence).not.toContain(TEST_MEMBERSHIP_JAMIE);
    expect(sentence).not.toContain(TEST_MEMBERSHIP_TAYLOR);
    expect(sentence).not.toContain(TEST_MEMBERSHIP_ALEX);
  });

  it('keeps ended copy subject-based when actor and subject differ', () => {
    expect(presentActivity(FIXTURE_LEFT).sentence).toBe('Jamie left the home');
  });

  it('keeps role-change copy grammatical when actor equals subject', () => {
    const item = activityItem({
      eventType: 'membership.role_changed.v1',
      sourceEntityType: 'MEMBERSHIP',
      sourceTitle: null,
      actor: { membershipId: TEST_MEMBERSHIP_JAMIE, name: 'Jamie' },
      subject: { membershipId: TEST_MEMBERSHIP_JAMIE, name: 'Jamie' },
    });
    expect(presentActivity(item).sentence).toBe(
      "Jamie updated Jamie's home role",
    );
  });

  it('uses the same maintenance sentence whether or not a title is present', () => {
    const titled = presentActivity(FIXTURE_MAINTENANCE_CREATED);
    const untitled = presentActivity({
      ...FIXTURE_MAINTENANCE_CREATED,
      sourceTitle: null,
    });
    expect(titled.sentence).toBe(untitled.sentence);
    expect(titled.icon).toBe(untitled.icon);
  });

  it('uses generic copy when both actor and subject are absent', () => {
    const ended = activityItem({
      eventType: 'membership.ended.v1',
      sourceEntityType: 'MEMBERSHIP',
      actor: null,
      subject: null,
      sourceTitle: null,
    });
    expect(presentActivity(ended).sentence).toBe('A roommate left the home');

    const role = activityItem({
      eventType: 'membership.role_changed.v1',
      sourceEntityType: 'MEMBERSHIP',
      actor: null,
      subject: null,
      sourceTitle: null,
    });
    expect(presentActivity(role).sentence).toBe('A home role was updated');
  });
});

describe('Maintenance Activity sentence parts', () => {
  it('splits actor-led Maintenance copy around the link phrase', () => {
    expect(
      maintenanceSentenceParts(presentActivity(FIXTURE_MAINTENANCE_CREATED)),
    ).toEqual({
      prefix: 'added a ',
      suffix: '',
    });
    expect(
      maintenanceSentenceParts(presentActivity(FIXTURE_MAINTENANCE_RESOLVED)),
    ).toEqual({
      prefix: 'resolved a ',
      suffix: '',
    });
  });

  it('splits actor-less Maintenance copy around the link phrase', () => {
    const created = activityItem({
      eventType: 'maintenance.created.v1',
      sourceEntityType: 'MAINTENANCE',
      sourceTitle: 'Quiet leak under sink',
      actor: null,
      subject: null,
    });
    expect(maintenanceSentenceParts(presentActivity(created))).toEqual({
      prefix: 'A ',
      suffix: ' was added',
    });
  });

  it('returns null for non-Maintenance Activity copy', () => {
    expect(
      maintenanceSentenceParts(presentActivity(FIXTURE_TASK_TITLED)),
    ).toBeNull();
  });
});

describe('Maintenance Activity detail href', () => {
  it('uses sourceEntityId for household Maintenance', () => {
    expect(maintenanceDetailHref(TEST_HOME_A, FIXTURE_MAINTENANCE_CREATED)).toBe(
      `/homes/${TEST_HOME_A}/maintenance/${SOURCE_MAINTENANCE_ID}`,
    );
    expect(
      maintenanceDetailHref(TEST_HOME_A, FIXTURE_MAINTENANCE_CREATED),
    ).not.toContain('Quiet leak');
  });

  it('does not link private Maintenance or other event types', () => {
    expect(
      maintenanceDetailHref(TEST_HOME_A, FIXTURE_MAINTENANCE_PRIVATE),
    ).toBeNull();
    expect(maintenanceDetailHref(TEST_HOME_A, FIXTURE_TASK_TITLED)).toBeNull();
    expect(maintenanceDetailHref('', FIXTURE_MAINTENANCE_CREATED)).toBeNull();
  });

  it('does not use the private sourceEntityId as a destination', () => {
    expect(
      maintenanceDetailHref(TEST_HOME_A, FIXTURE_MAINTENANCE_PRIVATE),
    ).toBeNull();
    expect(
      JSON.stringify(FIXTURE_MAINTENANCE_PRIVATE.sourceEntityId),
    ).toContain(SOURCE_MAINTENANCE_PRIVATE_ID);
  });
});
