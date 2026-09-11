import { MoreHorizontal, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { DocumentTitle } from '../components/document-title.js';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  IconButton,
  Menu,
  Radio,
  RadioGroup,
  Sheet,
  Skeleton,
  Spinner,
  Switch,
  Tabs,
  TextArea,
  TextField,
} from '../components/ui/index.js';

/**
 * Development-only visual QA fixture for UI primitives.
 * Not a product screen and not linked from production routes.
 */
export function UiFixturePage() {
  return (
    <DocumentTitle title="UI primitives — Roomies">
      <div className="flex flex-col gap-10 pb-16">
        <header className="space-y-2">
          <p className="text-sm font-medium text-text-muted">
            Development only
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
            UI primitives fixture
          </h1>
          <p className="max-w-prose text-sm text-text-secondary">
            Visual QA for Roomies interaction primitives. Resize to 360 / 390 /
            430 / 768 / 1024+ and exercise keyboard focus.
          </p>
        </header>

        <FixtureSection title="Button">
          <div className="flex flex-wrap gap-3">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="subtle">Subtle</Button>
            <Button variant="danger">Danger</Button>
            <Button disabled>Disabled</Button>
            <Button loading>Loading</Button>
            <Button icon={<Search className="size-4" aria-hidden="true" />}>
              With icon
            </Button>
          </div>
        </FixtureSection>

        <FixtureSection title="IconButton">
          <div className="flex flex-wrap items-center gap-3">
            <IconButton aria-label="Search">
              <Search className="size-5" aria-hidden="true" />
            </IconButton>
            <IconButton aria-label="More actions" variant="secondary">
              <MoreHorizontal className="size-5" aria-hidden="true" />
            </IconButton>
            <IconButton aria-label="Loading icon action" loading>
              <Search className="size-5" aria-hidden="true" />
            </IconButton>
          </div>
        </FixtureSection>

        <FixtureSection title="TextField / TextArea">
          <div className="grid gap-4 md:grid-cols-2">
            <TextField
              label="Display name"
              placeholder="Alex"
              helperText="Shown to roommates"
            />
            <TextField
              label="Email"
              type="email"
              required
              invalid
              errorText="Enter a valid email address"
              defaultValue="not-an-email"
            />
            <TextField
              label="Disabled field"
              disabled
              defaultValue="Unavailable"
            />
            <TextField
              label="With adornment"
              leading={<Search className="size-4" />}
              placeholder="Search…"
            />
            <div className="md:col-span-2">
              <TextArea
                label="Notes"
                helperText="Optional context"
                placeholder="Add a note"
              />
            </div>
          </div>
        </FixtureSection>

        <FixtureSection title="Checkbox / Radio / Switch">
          <div className="flex flex-col gap-4">
            <Checkbox label="Email me weekly summaries" defaultChecked />
            <Checkbox label="Disabled option" disabled />
            <RadioGroup label="Reminder frequency" defaultValue="daily">
              <Radio value="daily" label="Daily" />
              <Radio value="weekly" label="Weekly" />
              <Radio value="never" label="Never" />
            </RadioGroup>
            <Switch label="Show completed items" defaultChecked />
          </div>
        </FixtureSection>

        <FixtureSection title="Badge">
          <div className="flex flex-wrap gap-2">
            <Badge>Neutral</Badge>
            <Badge variant="brand">Brand</Badge>
            <Badge variant="success">Success</Badge>
            <Badge variant="warning">Warning</Badge>
            <Badge variant="danger">Danger</Badge>
            <Badge variant="info">Info</Badge>
            <Badge variant="privacy">Privacy</Badge>
          </div>
        </FixtureSection>

        <FixtureSection title="Alert">
          <div className="flex flex-col gap-3">
            <Alert variant="info" title="Heads up">
              Informational notice uses a polite status role.
            </Alert>
            <Alert variant="success" title="Saved">
              Changes were saved successfully.
            </Alert>
            <Alert variant="warning" title="Almost full">
              Storage is nearly at capacity.
            </Alert>
            <Alert variant="danger" title="Could not save">
              Fix the highlighted fields and try again.
            </Alert>
          </div>
        </FixtureSection>

        <FixtureSection title="Card / EmptyState">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <p className="text-sm font-medium text-text-primary">
                Card surface
              </p>
              <p className="mt-1 text-sm text-text-secondary">
                Restrained border, surface background, no shadow.
              </p>
            </Card>
            <EmptyState
              title="Nothing here yet"
              description="When items appear, they will show in this list."
              action={<Button variant="secondary">Add item</Button>}
            />
          </div>
        </FixtureSection>

        <FixtureSection title="Dialog / Sheet / Menu">
          <div className="flex flex-wrap gap-3">
            <Dialog.Root>
              <Dialog.Trigger
                render={<Button variant="secondary">Open dialog</Button>}
              />
              <Dialog.Popup
                title="Example dialog"
                description="Focus should move into the dialog and restore on close."
              >
                <p className="text-sm text-text-secondary">
                  Escape closes this dialog. The close control is labeled.
                </p>
              </Dialog.Popup>
            </Dialog.Root>

            <Sheet.Root>
              <Sheet.Trigger
                render={<Button variant="secondary">Open sheet</Button>}
              />
              <Sheet.Popup
                title="Example sheet"
                description="Edge panel for future mobile interactions."
                side="right"
              >
                <p className="text-sm text-text-secondary">
                  This sheet reuses Dialog focus management.
                </p>
              </Sheet.Popup>
            </Sheet.Root>

            <Sheet.Root>
              <Sheet.Trigger
                render={<Button variant="subtle">Open bottom sheet</Button>}
              />
              <Sheet.Popup title="Bottom sheet" side="bottom">
                <p className="text-sm text-text-secondary">
                  Bottom placement for compact mobile flows.
                </p>
              </Sheet.Popup>
            </Sheet.Root>

            <Menu.Root>
              <Menu.Trigger
                render={<Button variant="secondary">Open menu</Button>}
              />
              <Menu.Popup>
                <Menu.Item>Edit</Menu.Item>
                <Menu.Item>Duplicate</Menu.Item>
                <Menu.Separator />
                <Menu.Item>Archive</Menu.Item>
              </Menu.Popup>
            </Menu.Root>
          </div>
        </FixtureSection>

        <FixtureSection title="Tabs">
          <Tabs.Root defaultValue="open">
            <Tabs.List>
              <Tabs.Tab value="open">Open</Tabs.Tab>
              <Tabs.Tab value="done">Completed</Tabs.Tab>
              <Tabs.Tab value="all">All</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="open">Open items panel</Tabs.Panel>
            <Tabs.Panel value="done">Completed items panel</Tabs.Panel>
            <Tabs.Panel value="all">All items panel</Tabs.Panel>
          </Tabs.Root>
        </FixtureSection>

        <FixtureSection title="Spinner / Skeleton">
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3 text-text-secondary">
              <Spinner />
              <Spinner size="md" label="Still loading" />
            </div>
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-24 w-full" />
            </div>
          </div>
        </FixtureSection>

        <FixtureSection title="Focus examples">
          <p className="text-sm text-text-secondary">
            Tab through the controls above. Focus rings use the semantic focus
            token.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button variant="primary">Focus primary</Button>
            <Button variant="secondary">Focus secondary</Button>
            <TextField label="Focus field" placeholder="Tab here" />
          </div>
        </FixtureSection>
      </div>
    </DocumentTitle>
  );
}

function FixtureSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4 border-t border-border pt-8">
      <h2 className="text-base font-semibold text-text-primary">{title}</h2>
      {children}
    </section>
  );
}
