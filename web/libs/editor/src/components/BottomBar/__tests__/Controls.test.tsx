import { render, fireEvent } from "@testing-library/react";
import { Provider } from "mobx-react";
import { Controls } from "../Controls";
import * as featureFlags from "../../../utils/feature-flags";

jest.mock("@humansignal/ui", () => {
  const { forwardRef } = jest.requireActual("react");
  return {
    ButtonGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Button: forwardRef(({ children, ...props }: { children: React.ReactNode }) => {
      return (
        <button {...props} data-testid="button">
          {children}
        </button>
      );
    }),
    Tooltip: ({ children }: { children: React.ReactNode }) => {
      return <div data-testid="tooltip">{children}</div>;
    },
    Userpic: ({ children }: { children: React.ReactNode }) => {
      return (
        <div
          data-testid="userpic"
          className="userpic--tBKCQ"
          style={{ background: "rgb(155, 166, 211)", color: "rgb(0, 0, 0)" }}
        >
          {children}
        </div>
      );
    },
  };
});
const mockStore = {
  hasInterface: jest.fn(),
  isSubmitting: false,
  settings: {
    enableTooltips: true,
  },
  task: { id: 1, allow_skip: true },
  skipTask: jest.fn(),
  commentStore: {
    currentComment: {
      a3r0fa: "It's working",
      a0lsuf: "It's working fine",
    },
    commentFormSubmit: jest.fn(),
    setTooltipMessage: jest.fn(),
  },
  annotationStore: {
    selected: {
      submissionInProgress: jest.fn(),
      history: {
        canUndo: false,
      },
    },
  },
  customButtons: new Map(),
};

const mockHistory = {
  canUndo: false,
};

const mockAnnotation = {
  id: "a31wsd",
  canBeReviewed: false,
  userGenerate: false,
  sentUserGenerate: false,
  versions: {},
  results: [],
  editable: true,
};

// Helper to set up window.APP_SETTINGS for enterprise and role-based tests
const setupAppSettings = (options: { role?: string; enterprise?: boolean } = {}) => {
  (window as any).APP_SETTINGS = {
    user: {
      role: options.role,
    },
    billing: {
      enterprise: options.enterprise ?? false,
    },
  };
};

describe("Controls", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset APP_SETTINGS before each test
    (window as any).APP_SETTINGS = undefined;
    // Reset mockStore task to default
    mockStore.task = { id: 1, allow_skip: true };
  });

  test("When skip button is clicked, if there is no currentComment and annotators must leave a comment on skip, it must not submit and setToolTipMessage", () => {
    mockStore.hasInterface = (a: string) => (a === "skip" || a === "comments:skip") ?? true;

    const { getByLabelText } = render(
      <Provider store={mockStore}>
        <Controls history={mockHistory} annotation={mockAnnotation} />
      </Provider>,
    );

    const skipTask = getByLabelText("skip-task");
    fireEvent.click(skipTask);

    expect(mockStore.skipTask).not.toHaveBeenCalled();
    expect(mockStore.commentStore.commentFormSubmit).not.toHaveBeenCalled();
    expect(mockStore.commentStore.setTooltipMessage).toHaveBeenCalledWith("Please enter a comment before skipping");
  });

  test("When skip button is clicked, but there is an empty message on currentComment and annotators must leave a comment on skip, it must not submit and setToolTipMessage", () => {
    mockStore.hasInterface = (a: string) => (a === "skip" || a === "comments:skip") ?? true;
    mockStore.commentStore.currentComment.a31wsd = "   ";

    const { getByLabelText } = render(
      <Provider store={mockStore}>
        <Controls history={mockHistory} annotation={mockAnnotation} />
      </Provider>,
    );

    const skipTask = getByLabelText("skip-task");
    fireEvent.click(skipTask);

    expect(mockStore.skipTask).not.toHaveBeenCalled();
    expect(mockStore.commentStore.commentFormSubmit).not.toHaveBeenCalled();
    expect(mockStore.commentStore.setTooltipMessage).toHaveBeenCalledWith("Please enter a comment before skipping");
  });

  test("When skip button is clicked, if there is no currentComment and annotators doesn't need to leave a comment on skip, it must submit", async () => {
    mockStore.hasInterface = (a: string) => a === "skip";

    const { getByLabelText } = render(
      <Provider store={mockStore}>
        <Controls history={mockHistory} annotation={mockAnnotation} />
      </Provider>,
    );

    const skipTask = getByLabelText("skip-task");
    fireEvent.click(skipTask);

    await expect(mockStore.commentStore.commentFormSubmit).toHaveBeenCalled();
    expect(mockStore.skipTask).toHaveBeenCalled();
  });

  test("Skip button NOT disabled when allow_skip=false in LSO (non-enterprise)", () => {
    // In LSO (non-enterprise), allow_skip field doesn't exist/affect behavior
    setupAppSettings({ enterprise: false });
    mockStore.hasInterface = (a: string) => a === "skip";
    mockStore.task = { id: 1, allow_skip: false };

    const { getByLabelText } = render(
      <Provider store={mockStore}>
        <Controls history={mockHistory} annotation={mockAnnotation} />
      </Provider>,
    );

    const skipTask = getByLabelText("skip-task");
    // In LSO, skip button should NOT be disabled even when allow_skip=false
    expect(skipTask).not.toBeDisabled();
  });

  test("Skip button disabled when allow_skip=false in LSE (enterprise)", () => {
    setupAppSettings({ enterprise: true });
    mockStore.hasInterface = (a: string) => a === "skip";
    mockStore.task = { id: 1, allow_skip: false };

    const { getByLabelText } = render(
      <Provider store={mockStore}>
        <Controls history={mockHistory} annotation={mockAnnotation} />
      </Provider>,
    );

    const skipTask = getByLabelText("skip-task");
    expect(skipTask).toBeDisabled();
  });

  test("Skip button enabled when allow_skip=true in LSE (enterprise)", () => {
    setupAppSettings({ enterprise: true });
    mockStore.hasInterface = (a: string) => a === "skip";
    mockStore.task = { id: 1, allow_skip: true };

    const { getByLabelText } = render(
      <Provider store={mockStore}>
        <Controls history={mockHistory} annotation={mockAnnotation} />
      </Provider>,
    );

    const skipTask = getByLabelText("skip-task");
    expect(skipTask).not.toBeDisabled();
  });

  test("Skip action blocked when allow_skip=false in LSE (enterprise)", () => {
    setupAppSettings({ enterprise: true });
    mockStore.hasInterface = (a: string) => a === "skip";
    mockStore.task = { id: 1, allow_skip: false };
    mockStore.skipTask.mockClear();

    const { getByLabelText } = render(
      <Provider store={mockStore}>
        <Controls history={mockHistory} annotation={mockAnnotation} />
      </Provider>,
    );

    const skipTask = getByLabelText("skip-task");
    fireEvent.click(skipTask);

    expect(mockStore.skipTask).not.toHaveBeenCalled();
  });
});

describe("linked review draft Update", () => {
  afterEach(() => jest.restoreAllMocks());
  test.each([
    [0, true, false, true],
    [9, true, false, false],
    [9, false, false, true],
    [9, true, true, true],
  ])("draft=%s editable=%s incomplete=%s disabled=%s", (draftId, editable, hasIncompletePolygons, disabled) => {
    jest.spyOn(featureFlags, "isFF").mockImplementation((flag) => flag === featureFlags.FF_REVIEWER_FLOW);
    mockStore.hasInterface = (name: string) => name === "update";
    const { getByRole } = render(
      <Provider store={mockStore}>
        <Controls history={mockHistory} annotation={{ ...mockAnnotation, draftId, editable, hasIncompletePolygons }} />
      </Provider>,
    );
    expect(getByRole("button", { name: "submit" }).hasAttribute("disabled")).toBe(disabled);
  });
});
