/**
 * The mock transport's alert destinations: the four `alert_destination*`
 * commands and the `alert-destinations-changed` event, behaving as Rust's
 * `AlertsService` does (validation, at most 8, replace by id, the last
 * delivery per destination). The `alert-delivery-fails` scenario makes every
 * test delivery fail.
 */
import type { MockCommands } from "./commands";
import type { MockTransport } from "./contracts";
import type { MockEmitters } from "./emitters";
import type { ScenarioFlags } from "./fixtures";

/** Mock owner of the alert destinations, registered by `createMockTransport`. */
export class MockAlertDestinations {
  /** Set by the `alert-delivery-fails` scenario: test deliveries fail. */
  readonly deliveryFails: boolean;
  constructor(
    private readonly commands: MockCommands,
    private readonly emitters: MockEmitters,
    flags: ScenarioFlags
  ) {
    this.deliveryFails = flags.alertDeliveryFails;
  }
  readonly getAlertDestinations: MockTransport["getAlertDestinations"] =
    async () => {
      this.commands.record("alert_destinations_get");
      throw new Error("not implemented");
    };
  readonly saveAlertDestination: MockTransport["saveAlertDestination"] = async (
    destination
  ) => {
    this.commands.record("alert_destination_save", destination);
    throw new Error("not implemented");
  };
  readonly deleteAlertDestination: MockTransport["deleteAlertDestination"] =
    async (id) => {
      this.commands.record("alert_destination_delete", id);
      throw new Error("not implemented");
    };
  readonly testAlertDestination: MockTransport["testAlertDestination"] = async (
    destination
  ) => {
    this.commands.record("alert_destination_test", destination);
    throw new Error("not implemented");
  };
  readonly onAlertDestinationsChanged: MockTransport["onAlertDestinationsChanged"] =
    (cb) => this.emitters.alertDestinations.on(cb);

  get methods() {
    return {
      getAlertDestinations: this.getAlertDestinations,
      saveAlertDestination: this.saveAlertDestination,
      deleteAlertDestination: this.deleteAlertDestination,
      testAlertDestination: this.testAlertDestination,
      onAlertDestinationsChanged: this.onAlertDestinationsChanged,
    };
  }
}
