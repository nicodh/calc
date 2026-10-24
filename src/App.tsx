import "./App.css";
import styled from "@emotion/styled";
import { useEffect, useRef, useState } from "react";
import {
  createNewModel,
  loadSelectedModelFromStorage,
  modelFromBytes,
  saveSelectedModelInStorage,
  updateNameSelectedWorkbook,
} from "./components/storage";
import {
  type Base,
  type Phase,
  getBase,
  getCreatedAt,
  getPhase,
  isEarlier,
  journalAppend,
  journalEntries,
  markEstablished,
  markProvisional,
  rebaseOnto,
} from "./components/bootstrap";
import { getDeviceUuid, getSessionId } from "./components/session";

// From IronCalc
import { IronCalc, IronCalcIcon, Model, init } from "@ironcalc/workbook";
import "@ironcalc/workbook/style.css";

import { Webxdc } from "@webxdc/types";
import { encode as base64Encode, decode as base64Decode } from "base64-arraybuffer";

// A diff, unless `kind` says the payload carries a whole workbook. A snapshot
// names the workbook it is, so devices can agree which one is the earliest.
type Payload = {
  data: string;
  sender: string;
  kind?: "snapshot";
  createdAt?: number;
  session?: number;
};

// How long the update log has to stay quiet before a provisional workbook
// concludes that nobody else has one. Delta Chat replays the stored history
// as soon as the listener is registered, so this only has to outlast that
// replay; the window restarts on every update. A peer whose snapshot arrives
// later still converges, through the earliest-workbook rule.
const BOOTSTRAP_QUIET_MS = 1500;

// Concurrent WASM initialization can replace the instance backing existing
// models. Share the pending initialization across StrictMode effect runs.
let initialization: ReturnType<typeof init> | undefined;

declare global {
  interface Window {
    webxdc: Webxdc<Payload>;
    // We expose the current model so Playwright tests can access the IronCalc model.
    // This is only set in dev mode.
    __model?: Model;
  }
}

function decode(data: string): Uint8Array {
  return new Uint8Array(base64Decode(data));
}

function App() {
  const [model, setModel] = useState<Model | null>(null);

  // Bumped whenever we apply a remote diff to the model. We pass this to
  // IronCalc so it repaints the canvas without resetting the workbook
  // interaction state (the in-progress cell edit, selection, focus).
  const [externalRevision, setExternalRevision] = useState(0);

  // We keep a reference to the model. This way we can register callbacks that
  // accesss this without having to re-register them when the model is replaced.
  const modelRef = useRef<Model | null>(null);

  // Whether this device has settled on a workbook. The ref is read by the
  // callbacks, the state drives rendering: a provisional workbook is shown
  // read-only, so nobody types into a workbook that may still be replaced.
  const phaseRef = useRef<Phase>("established");
  const [phase, setPhase] = useState<Phase>("established");
  // Diffs that arrive while still provisional. They belong to whatever
  // workbook we settle on, so they wait for it.
  const pendingRef = useRef<{ data: string; serial: number }[]>([]);
  const quietTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // We keep the model in sync with the model ref. We also make sure it's
  // exposed on the window for tests in dev mode.
  useEffect(() => {
    modelRef.current = model;
    if (import.meta.env.DEV && model) {
      window.__model = model;
    }
  }, [model]);


  // a unique identifier for this client.
  const uuid = getDeviceUuid();

  useEffect(() => {
    // because React StrictMode runs useEffect twice in dev, we want to make
    // sure we don't actually
    let cancelled = false;
    async function start() {
      initialization ??= init();
      await initialization;
      // the first time around in StrictMode, we have been cancelled so
      // we don't attempt to set the model.
      if (cancelled) {
        return;
      }
      // the second time in StrictMode (or the first time outside of StrictMode) is the real one
      // so we load the model from storage or create a new one and set it in state.
      const storedModel = loadSelectedModelFromStorage();
      let newModel: Model;
      if (storedModel) {
        newModel = storedModel;
        // A workbook created in an earlier session may still be waiting to
        // find out whether the chat has one of its own.
        settle(getPhase());
      } else {
        // A replay cursor is only valid together with the workbook it describes.
        localStorage.removeItem("last_serial");
        // With no cached local edits, historical updates from this device
        // must also be replayed instead of being mistaken for live echoes.
        localStorage.removeItem("uuid");
        newModel = createNewModel();
        markProvisional(Date.now());
        settle("provisional");
      }
      setModel(newModel);
    }
    // we start the async here, not waiting for its completion
    start();
    return () => {
      // if this gets torn down (which happens in StrictMode), we don't try to set the model twice.
      cancelled = true;
    };
  }, []);

  function settle(next: Phase) {
    phaseRef.current = next;
    setPhase(next);
  }

  function send(payload: Payload) {
    if (import.meta.env.DEV) {
      console.log("[calc:update]", payload.kind ?? "diff", payload.data.length);
    }
    window.webxdc.sendUpdate({ payload }, "");
  }

  // Sends what the user did since the last tick, and journals it.
  function flushOutgoing(model: Model) {
    const diff = model.flushSendQueue();
    // length 1 encoded is the empty vec, which is a no-op.
    if (diff.length <= 1) {
      return;
    }
    saveSelectedModelInStorage(model);
    const data = base64Encode(diff.buffer as ArrayBuffer);
    journalAppend(data);
    send({ data, sender: uuid });
  }

  // Outgoing: flush local edits to peers on an interval.
  useEffect(() => {
    const int = setInterval(() => {
      const model = modelRef.current;
      // A provisional workbook sends nothing. Creating it emitted commits of
      // its own, and they are stamped later than any workbook the chat
      // already shares: they would reset that workbook's sheet for everyone.
      if (!model || phaseRef.current === "provisional") {
        return
      }
      flushOutgoing(model);
    }, 1000)
    return () => {
      clearInterval(int)
    }
  }, [uuid])

  // Applies a diff to the workbook we have settled on, journals and saves it,
  // and only then acknowledges it.
  function applyDiff(model: Model, data: string, serial: number) {
    try {
      model.applyExternalDiffs(decode(data));
    } catch (error) {
      console.error("[calc] could not apply an update", serial, error);
    }
    journalAppend(data);
    saveSelectedModelInStorage(model);
    localStorage.setItem("last_serial", serial.toString());
  }

  function drainPending(model: Model) {
    const pending = pendingRef.current;
    pendingRef.current = [];
    for (const { data, serial } of pending) {
      applyDiff(model, data, serial);
    }
  }

  // Replaces the model object; IronCalc remounts on the new one.
  function replaceModel(next: Model) {
    modelRef.current = next;
    saveSelectedModelInStorage(next);
    updateNameSelectedWorkbook(next, next.getName());
    setModel(next);
  }

  // Nobody else has a workbook, so ours becomes the shared one. The snapshot
  // goes out first and by itself.
  function becomeCreator() {
    const model = modelRef.current;
    if (!model || phaseRef.current !== "provisional") {
      return
    }
    const base: Base = { createdAt: getCreatedAt(), session: getSessionId() };
    // The queue holds the commits that created this workbook. The snapshot
    // replaces them, so they are dropped rather than sent behind it.
    model.flushSendQueue();
    const data = base64Encode(model.toBytes().buffer as ArrayBuffer);
    // The host advertises a limit, or reports 0 for "no answer".
    const limit = window.webxdc.sendUpdateMaxSize || Number.POSITIVE_INFINITY;
    if (data.length > limit) {
      console.error(
        `[calc] the workbook snapshot is ${data.length} bytes, over the host limit of ${limit}; peers cannot join from it`,
      );
    } else {
      send({ data, sender: uuid, kind: "snapshot", ...base });
    }
    markEstablished(base);
    saveSelectedModelInStorage(model);
    drainPending(model);
    settle("established");
    setExternalRevision((revision) => revision + 1);
  }

  // Somebody else's workbook is the shared one, and ours was never more than
  // a read-only placeholder: take theirs, with our own replica identity.
  function adoptSnapshot(payload: Payload, serial: number) {
    clearTimeout(quietTimer.current);
    const adopted = modelFromBytes(decode(payload.data));
    markEstablished(baseOf(payload));
    localStorage.setItem("last_serial", serial.toString());
    // Diffs held back while provisional belong to this workbook.
    drainPending(adopted);
    replaceModel(adopted);
    settle("established");
  }

  // An earlier workbook than the one we are on: move onto it and replay
  // everything sent or applied since our base. All of it was written after
  // our base was created, so after this earlier one too, and applies cleanly.
  function rebaseOnSnapshot(model: Model, payload: Payload, base: Base, serial: number) {
    // What the user did since the last tick goes out first, and into the journal.
    flushOutgoing(model);
    const rebased = modelFromBytes(decode(payload.data));
    const entries = journalEntries();
    for (const entry of entries) {
      try {
        rebased.applyExternalDiffs(decode(entry));
      } catch (error) {
        console.error("[calc] could not replay a journalled update", error);
      }
    }
    rebaseOnto(base);
    localStorage.setItem("last_serial", serial.toString());
    replaceModel(rebased);
    if (import.meta.env.DEV) {
      console.log(`[calc] rebased onto an earlier workbook, replayed ${entries.length} updates`);
    }
  }

  // The armed timer belongs to whichever effect run armed it last, so StrictMode's
  // second run re-arms what the first run's cleanup cleared.
  function armQuietTimer() {
    if (phaseRef.current !== "provisional") {
      return
    }
    clearTimeout(quietTimer.current);
    quietTimer.current = setTimeout(becomeCreator, BOOTSTRAP_QUIET_MS);
  }

  useEffect(() => {
    if (!model) {
      return
    }
    armQuietTimer();
    return () => {
      clearTimeout(quietTimer.current);
    };
  }, [model])

  // React by default uses StrictMode in dev to flush out bugs. This invokes
  // useEffect twice. But webxdc expects a single update listener registration.
  // This ref is to make sure it's registered only once.
  const listenerRegistered = useRef(false);

  // Incoming: apply remote diffs to the model.
  useEffect(() => {
    // Register only after WASM and the workbook are ready.
    // Delta Chat retains updates and replays them when we register.
    if (!model || listenerRegistered.current) {
      return
    }
    listenerRegistered.current = true
    window.webxdc.setUpdateListener((update) => {
      const model = modelRef.current;
      const payload = update.payload;
      if (!model) {
        console.warn("Received external diffs but model is not initialized yet");
        return
      }
      if (payload.sender === uuid) {
        localStorage.setItem("last_serial", update.serial.toString());
        return
      }
      if (payload.kind === "snapshot") {
        if (phaseRef.current === "provisional") {
          adoptSnapshot(payload, update.serial);
        } else if (isEarlier(baseOf(payload), getBase())) {
          rebaseOnSnapshot(model, payload, baseOf(payload)!, update.serial);
        } else {
          // A later workbook than ours. Its diffs apply to ours; the
          // snapshot itself has nothing for us.
          localStorage.setItem("last_serial", update.serial.toString());
        }
        return
      }
      if (phaseRef.current === "provisional") {
        // Not acknowledged: a restart replays it.
        pendingRef.current.push({ data: payload.data, serial: update.serial });
        armQuietTimer();
        return
      }
      applyDiff(model, payload.data, update.serial);
      // The model is mutated in place; bump the revision so IronCalc repaints
      // the canvas without disturbing an in-progress edit.
      setExternalRevision((revision) => revision + 1);
    }, get_last_serial())
  }, [model, uuid])


  if (!model) {
    return (
      <Loading>
        <IronCalcIcon style={{ width: 24, height: 24, marginBottom: 16 }} />
        <div>Loading IronCalc</div>
      </Loading>
    );
  }


  // We could use context for model, but the problem is that it should initialized to null.
  // Passing the property down makes sure it is always defined.

  return (
    <Wrapper>
      <IronCalc
        model={model}
        revision={externalRevision}
        canEdit={phase === "established"}
      />
    </Wrapper>
  );
}

// The workbook a snapshot names. A snapshot from a build that did not name it
// counts as unknown, and loses to any that does.
function baseOf(payload: Payload): Base | null {
  if (typeof payload.createdAt === "number" && typeof payload.session === "number") {
    return { createdAt: payload.createdAt, session: payload.session };
  }
  return null;
}

const Wrapper = styled("div")`
  margin: 0px;
  padding: 0px;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  position: absolute;
`;

const Loading = styled("div")`
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-family: "Inter";
  font-size: 14px;
`;

export default App;

function get_last_serial(): number {
  const last_serial = localStorage.getItem("last_serial");
  if (last_serial === null) {
    localStorage.setItem("last_serial", "0");
    return 0;
  }
  return parseInt(last_serial, 10) || 0;
}
