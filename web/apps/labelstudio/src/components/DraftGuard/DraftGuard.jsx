import { useContext, useEffect } from "react";
import { useHistory } from "react-router-dom";
import { ToastContext } from "@humansignal/ui";

export const DRAFT_GUARD_KEY = "DRAFT_GUARD";

export const draftGuardCallback = {
  current: null,
};

export const DraftGuard = () => {
  const toast = useContext(ToastContext);
  const history = useHistory();

  useEffect(() => {
    const unblock = () => {
      draftGuardCallback.current?.(true);
      draftGuardCallback.current = null;
    };

    /**
     * The version of Router History that is in use does not currently support
     * the `block` method fully. This is a workaround to allow us to block navigation
     * when there are unsaved changes. The draftGuardCallback allows the unblock callback to be captured from the
     * history callback `getUserConfirmation` that is triggered by returning a string message from history.block, allowing the user to
     * confirm they want to leave the page. Here we send through a constant message
     * to signify that we aren't looking for user confirmation but to utilize this to enable navigation blocking based on
     * unsuccessful draft saves.
     */
    const unsubscribe = history.block(() => {
      const selected = window.Htx?.annotationStore?.selected;
      const submissionInProgress = !!selected?.submissionStarted;
      const dirty =
        selected?.savedResultFingerprint != null
          ? selected.draftResultFingerprint !== selected.savedResultFingerprint
          : !!selected?.history.undoIdx;
      const hasChanges =
        !!selected && !submissionInProgress && (dirty || selected.isDraftSaving || selected.draftSaveError);

      if (hasChanges) {
        selected
          .saveDraftImmediatelyWithResults()
          ?.then((res) => {
            const status = res?.$meta?.status;

            if (status === 200 || status === 201) {
              toast.show({ message: "Draft saved successfully", type: "info" });
              unblock();
            } else if (status !== undefined) {
              toast.show({ message: "There was an error saving your draft", type: "error" });
            } else toast.show({ message: "草稿尚未确认保存，请保留当前窗口", type: "error" });
          })
          .catch((error) => {
            toast.show({ message: error?.message || "草稿保存失败，请保留当前窗口", type: "error" });
          });

        return DRAFT_GUARD_KEY;
      }
    });

    return () => {
      unblock();
      unsubscribe();
    };
  }, []);

  return <></>;
};
