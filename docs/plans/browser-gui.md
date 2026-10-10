# Browser access to the released GUI

Status: complete
Owner: desktop/ and src/http/

Reuse the GUI and controller from `desktop-v0.0.1`. A browser transport will
share the existing named desktop API and streamed events. The controller owns
one agent process; host gateways continue to own inference processes.

1. Expose the existing GUI API through a loopback HTTP/SSE bridge with origin,
   session and request-size checks. Adapt browser file downloads, workspace
   selection and menus; omit desktop-only microphone controls.
2. Add shared HTTP gateway controls and the GUI's model-gateway panel. Status
   reads must not load models, and selection must use the inference host's
   catalog rather than the M2's memory limit.
3. Test with disposable state before replacing the terminal service. Verify
   live chat, approvals, cancellation, reconnect, model selection and Stop all.
4. Deploy at the existing private Tailscale URL with the existing state directory
   and one runtime. Verify unloaded startup and process shutdown. Publish the
   fork, include desktop releases in update review, and remove the task worktree.

Existing model weights and the Solo default remain in use. The proposed WSL
worker download is separate and still awaits the user's decision.

Acceptance: the private HTTPS URL serves the actual GUI with the existing agent
state and all configured host models. Browser QA passed live streaming, an exact
file write/read, approval allow/deny, reopening a pending approval, Stop all,
on-demand loading from a stopped host, and controller reconnect without an
orphan agent. The terminal service was replaced and its launcher archived.
Desktop unit tests, focused core seam tests, type checks, dependency/document
checks and the core registry gate passed. The deployed source remains in the
main checkout; the merged task worktree and research checkout were removed.

Muse remains the tested main model. A separate Lightning smoke task repeated
reads without finishing and was cancelled. The existing 4B WSL worker remains
experimental; no additional model weights were downloaded for this GUI change.
