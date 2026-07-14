// Model transport now lives in the shared package so the browser editor can
// drive providers directly; this shim keeps service-internal imports stable.
export {
  cancelledTransportError,
  createFakeDesignMateModelTransport,
  isValidTransportId,
  throwIfTransportAborted,
  type DesignMateModelTransport,
  type FakeDesignMateModelTransport,
  type FakeDesignMateModelTransportOptions,
} from "@openlogo/design-mate";
