#ifndef FRAME_CLIENT_H
#define FRAME_CLIENT_H
#include <stddef.h>
enum { FRAME_OK = 0, FRAME_ARGUMENT = -1, FRAME_CONNECT = -2,
       FRAME_IO = -3, FRAME_TIMEOUT = -4, FRAME_PROTOCOL = -5, FRAME_CAPACITY = -6 };
/* On success, publish the payload and its length. On any failure both output
 * buffers remain unchanged. NULL output is allowed only when capacity is zero.
 * timeout_ms is a total I/O budget, not a fresh budget for each retry. */
int frame_fetch(const char *endpoint, unsigned char id, unsigned char *output,
                size_t capacity, size_t *output_size, unsigned timeout_ms);
#endif
