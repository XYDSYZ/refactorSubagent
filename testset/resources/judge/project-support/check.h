#ifndef PROJECT_CHECK_H
#define PROJECT_CHECK_H
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static unsigned observed_checks;
/* Always finish and print the exact failed invariant. Behavioral failures
 * remain observations, not crashes or artificial infrastructure errors. */
#define CHECK(name, condition) do { \
    int observed = !!(condition); \
    printf("%s=%d\n", name, observed); \
    observed_checks++; \
} while (0)
static void completed(void) { printf("checks=%u\n", observed_checks); }
#endif
