#ifndef TRANSPORT_H
#define TRANSPORT_H
#include <stddef.h>
#include <stdint.h>
typedef struct transport transport;
/* SDK ABI. A positive count may be smaller than the request. Zero means
 * disconnected; -1 means fatal I/O; -2 means temporarily unavailable.
 * A call consumes at most the supplied remaining timeout in milliseconds.
 * now_ms is monotonic. close consumes a successfully opened handle once. */
transport *transport_open(const char *endpoint);
long transport_write(transport *, const unsigned char *, size_t, unsigned remaining_ms);
long transport_read(transport *, unsigned char *, size_t, unsigned remaining_ms);
uint64_t transport_now_ms(void);
void transport_close(transport *);
#endif
