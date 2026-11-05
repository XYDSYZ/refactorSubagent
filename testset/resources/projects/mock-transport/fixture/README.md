# Frame device client

`frame_fetch` exchanges one request with a device using the externally supplied
DeviceSDK 4 transport implementation. This checkout includes the complete ABI
contract in `include/transport.h`, but no SDK binary, device, or test runner.

Request bytes: `A5 ID`. Reply bytes: `5A ID LEN_HI LEN_LO PAYLOAD CHECKSUM`.
Length is unsigned big endian, at most 256. CHECKSUM is XOR of every preceding
reply byte, including the header. Empty payloads are valid. Binary zero bytes
are payload, not terminators. A response must echo the request ID.

The SDK permits partial reads/writes and temporary unavailability (`-2`).
Zero means disconnection. Successful connections must be closed exactly once
on every return path. The I/O deadline applies to the whole exchange. Monotonic
clock values may start anywhere; tests must not require an epoch of zero.
Return codes and output ownership are documented in `frame_client.h`.

The production CMake build requires the SDK package. The protocol and ABI above
are the supported contract for an integrator supplying the dependency.
