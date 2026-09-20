import { Component, type ReactNode } from "react";
import { Button, Notice } from "../../ui";

/** A failed subscription must not take down the room viewer or conversation. */
export class DesignSyncBoundary extends Component<
  {
    children: ReactNode;
    onDisconnect: () => void;
  },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onDisconnect();
  }
  render() {
    return this.state.failed ? (
      <Notice tone="error">
        Room sync is unavailable. Your saved layout is still here.{" "}
        <Button size="sm" onClick={() => this.setState({ failed: false })}>
          Reconnect
        </Button>
      </Notice>
    ) : (
      this.props.children
    );
  }
}
