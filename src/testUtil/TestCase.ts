import * as vscode from "vscode";
import { ThatMark } from "../core/ThatMark";
import { Target, Token } from "../typings/Types";
import {
  extractTargetedMarks,
  extractTargetKeys,
} from "./extractTargetedMarks";
import { marksToPlainObject, SerializedMarks } from "./toPlainObject";
import {
  ExtraSnapshotField,
  takeSnapshot,
  TestCaseSnapshot,
} from "./takeSnapshot";
import serialize from "./serialize";
import { pick } from "lodash";
import { ReadOnlyHatMap } from "../core/IndividualHatMap";
import { CommandArgument } from "../core/commandRunner/types";
import { cleanUpTestCaseCommand } from "./cleanUpTestCaseCommand";

export type TestCaseCommand = CommandArgument;

export type TestCaseContext = {
  thatMark: ThatMark;
  sourceMark: ThatMark;
  targets: Target[];
  hatTokenMap: ReadOnlyHatMap;
};

export type TestCaseFixture = {
  languageId: string;
  command: TestCaseCommand;

  /**
   * A list of marks to check in the case of navigation map test otherwise undefined
   */
  marksToCheck?: string[];

  initialState: TestCaseSnapshot;
  finalState: TestCaseSnapshot;
  returnValue: unknown;
  /** Inferred full targets added for context; not currently used in testing */
  fullTargets: Target[];
};

export class TestCase {
  languageId: string;
  fullTargets: Target[];
  initialState: TestCaseSnapshot | null = null;
  finalState: TestCaseSnapshot | null = null;
  returnValue: unknown = null;
  targetKeys: string[];
  private _awaitingFinalMarkInfo: boolean;
  marksToCheck?: string[];
  public command: TestCaseCommand;

  constructor(
    command: TestCaseCommand,
    private context: TestCaseContext,
    private isHatTokenMapTest: boolean = false,
    private startTimestamp: bigint,
    private extraSnapshotFields?: ExtraSnapshotField[]
  ) {
    const activeEditor = vscode.window.activeTextEditor!;
    this.command = cleanUpTestCaseCommand(command);

    const { targets } = context;

    this.targetKeys = targets.map(extractTargetKeys).flat();

    this.languageId = activeEditor.document.languageId;
    this.fullTargets = targets;
    this._awaitingFinalMarkInfo = isHatTokenMapTest;
  }

  private getMarks() {
    let marks: Record<string, Token>;

    const { hatTokenMap } = this.context;

    if (this.isHatTokenMapTest) {
      // If we're doing a navigation map test, then we grab the entire
      // navigation map because we'll filter it later based on the marks
      // referenced in the expected follow up command
      marks = Object.fromEntries(hatTokenMap.getEntries());
    } else {
      marks = extractTargetedMarks(this.targetKeys, hatTokenMap);
    }

    return marksToPlainObject(marks);
  }

  private includesThatMark(target: Target, type: string): boolean {
    if (target.type === "primitive" && target.mark.type === type) {
      return true;
    } else if (target.type === "list") {
      return target.elements.some((target) =>
        this.includesThatMark(target, type)
      );
    } else if (target.type === "range") {
      return [target.anchor, target.active].some((target) =>
        this.includesThatMark(target, type)
      );
    }
    return false;
  }

  private getExcludedFields(context?: { initialSnapshot?: boolean }) {
    const excludableFields = {
      clipboard: !["copy", "paste"].includes(this.command.action),
      thatMark:
        context?.initialSnapshot &&
        !this.fullTargets.some((target) =>
          this.includesThatMark(target, "that")
        ),
      sourceMark:
        context?.initialSnapshot &&
        !this.fullTargets.some((target) =>
          this.includesThatMark(target, "source")
        ),
      visibleRanges: ![
        "fold",
        "unfold",
        "scrollToBottom",
        "scrollToCenter",
        "scrollToTop",
      ].includes(this.command.action),
    };

    return Object.keys(excludableFields).filter(
      (field) => excludableFields[field]
    );
  }

  toYaml() {
    if (this.initialState == null || this.finalState == null) {
      throw Error("Two snapshots must be taken before serializing");
    }
    const fixture: TestCaseFixture = {
      languageId: this.languageId,
      command: this.command,
      marksToCheck: this.marksToCheck,
      initialState: this.initialState,
      finalState: this.finalState,
      returnValue: this.returnValue,
      fullTargets: this.fullTargets,
    };
    return serialize(fixture);
  }

  async recordInitialState() {
    const excludeFields = this.getExcludedFields({ initialSnapshot: true });
    this.initialState = await takeSnapshot(
      this.context.thatMark,
      this.context.sourceMark,
      excludeFields,
      this.extraSnapshotFields,
      this.getMarks(),
      { startTimestamp: this.startTimestamp }
    );
  }

  async recordFinalState(returnValue: unknown) {
    const excludeFields = this.getExcludedFields();
    this.returnValue = returnValue;
    this.finalState = await takeSnapshot(
      this.context.thatMark,
      this.context.sourceMark,
      excludeFields,
      this.extraSnapshotFields,
      this.isHatTokenMapTest ? this.getMarks() : undefined,
      { startTimestamp: this.startTimestamp }
    );
  }

  filterMarks(command: TestCaseCommand, context: TestCaseContext) {
    const marksToCheck = context.targets.map(extractTargetKeys).flat();
    const keys = this.targetKeys.concat(marksToCheck);

    this.initialState!.marks = pick(
      this.initialState!.marks,
      keys
    ) as SerializedMarks;

    this.finalState!.marks = pick(
      this.finalState!.marks,
      keys
    ) as SerializedMarks;

    this.marksToCheck = marksToCheck;

    this._awaitingFinalMarkInfo = false;
  }

  get awaitingFinalMarkInfo() {
    return this._awaitingFinalMarkInfo;
  }
}
