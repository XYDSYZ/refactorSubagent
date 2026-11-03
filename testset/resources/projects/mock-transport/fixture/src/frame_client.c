#include "frame_client.h"
#include "transport.h"
#include <stdint.h>
#include <string.h>

static unsigned char frame_checksum(const unsigned char *p, size_t n) {
    unsigned char c = 0;
    while (n--) c ^= *p++;
    return c;
}

int frame_fetch(const char *endpoint, unsigned char id, unsigned char *output,
                size_t capacity, size_t *output_size, unsigned timeout_ms) {
    unsigned char request[2] = {0xa5, id}, header[4], payload[257];
    size_t sent = 0, received = 0, payload_size;
    int result = FRAME_IO;
    uint64_t began;
    transport *connection;
    if (!endpoint || !output_size || (!output && capacity)) return FRAME_ARGUMENT;
    connection = transport_open(endpoint);
    if (!connection) return FRAME_CONNECT;
    began = transport_now_ms();

    while (sent < sizeof request) {
        uint64_t elapsed = transport_now_ms() - began;
        long n;
        if (elapsed >= timeout_ms) { result = FRAME_TIMEOUT; goto finish; }
        n = transport_write(connection, request + sent, sizeof request - sent,
                            timeout_ms - (unsigned)elapsed);
        if (n == -2) continue;
        if (n <= 0 || (size_t)n > sizeof request - sent) goto finish;
        sent += (size_t)n;
    }
    while (received < sizeof header) {
        uint64_t elapsed = transport_now_ms() - began;
        long n;
        if (elapsed >= timeout_ms) { result = FRAME_TIMEOUT; goto finish; }
        n = transport_read(connection, header + received, sizeof header - received,
                           timeout_ms - (unsigned)elapsed);
        if (n == -2) continue;
        if (n <= 0 || (size_t)n > sizeof header - received) goto finish;
        received += (size_t)n;
    }
    if (header[0] != 0x5a || header[1] != id) { result = FRAME_PROTOCOL; goto finish; }
    payload_size = ((size_t)header[2] << 8) | header[3];
    if (payload_size > 256) { result = FRAME_PROTOCOL; goto finish; }
    if (payload_size > capacity) { result = FRAME_CAPACITY; goto finish; }
    received = 0;
    while (received < payload_size + 1) {
        uint64_t elapsed = transport_now_ms() - began;
        long n;
        if (elapsed >= timeout_ms) { result = FRAME_TIMEOUT; goto finish; }
        n = transport_read(connection, payload + received, payload_size + 1 - received,
                           timeout_ms - (unsigned)elapsed);
        if (n == -2) continue;
        if (n <= 0 || (size_t)n > payload_size + 1 - received) goto finish;
        received += (size_t)n;
    }
    if ((frame_checksum(header, sizeof header) ^ frame_checksum(payload, payload_size)) != payload[payload_size]) {
        result = FRAME_PROTOCOL;
        goto finish;
    }
    if (payload_size) memcpy(output, payload, payload_size);
    *output_size = payload_size;
    result = FRAME_OK;
finish:
    transport_close(connection);
    return result;
}
