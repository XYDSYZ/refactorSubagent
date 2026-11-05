#include "frame_client.h"
#include "transport.h"
#include "check.h"
#include <stdint.h>
struct transport { int alive; };
static struct transport connection;
static unsigned char response[300],request_seen[16];
static size_t response_size,response_at,request_size,chunk;
static int open_failure,write_retries,read_retries,blocked_read,fatal_read,closed,bad_budget;
static uint64_t clock_value;
static unsigned tick,last_budget;

transport *transport_open(const char *endpoint) {
    if(strcmp(endpoint,"device:unit")) abort();
    if(open_failure) return NULL;
    connection.alive=1;return &connection;
}
uint64_t transport_now_ms(void) { uint64_t now=clock_value;clock_value+=tick;return now; }
static void budget(transport *c,unsigned remaining) {
    if(c!=&connection || !c->alive || !remaining || remaining>last_budget)bad_budget=1;
    last_budget=remaining;
}
long transport_write(transport *c,const unsigned char *data,size_t size,unsigned remaining) {
    budget(c,remaining);if(write_retries-->0)return -2;
    size_t n=size<chunk?size:chunk;
    if(n>sizeof request_seen-request_size) return -1;
    memcpy(request_seen+request_size,data,n);request_size+=n;return (long)n;
}
long transport_read(transport *c,unsigned char *data,size_t size,unsigned remaining) {
    budget(c,remaining);
    if(blocked_read || read_retries-->0)return -2;
    if(fatal_read)return -1;
    size_t n=response_size-response_at;if(n>size)n=size;if(n>chunk)n=chunk;
    memcpy(data,response+response_at,n);response_at+=n;return (long)n;
}
void transport_close(transport *c) {
    closed++;if(c!=&connection || !c->alive)bad_budget=1;
    c->alive=0;
}
static void reset(size_t size) {
    memset(&connection,0,sizeof connection);memset(request_seen,0,sizeof request_seen);
    response[0]=0x5a;response[1]=19;response[2]=(unsigned char)(size>>8);response[3]=(unsigned char)size;
    for(size_t i=0;i<size;i++)response[4+i]=(unsigned char)(i*17);
    unsigned char checksum=0;for(size_t i=0;i<size+4;i++)checksum^=response[i];response[size+4]=checksum;
    response_size=size+5;response_at=request_size=0;chunk=300;
    open_failure=write_retries=read_retries=blocked_read=fatal_read=closed=bad_budget=0;
    clock_value=123456789;tick=1;last_budget=~0u;
}
static void exercise(const char *name,size_t capacity,int expected,unsigned timeout,int null_output) {
    unsigned char output[300],untouched[300];memset(output,0xa7,sizeof output);memcpy(untouched,output,sizeof output);
    size_t size=0xcafe;
    int result=frame_fetch("device:unit",19,null_output?NULL:output,capacity,&size,timeout);
    int ok=result==expected && closed==(open_failure?0:1) && !bad_budget;
    if(expected==FRAME_OK) {
        size_t payload=((size_t)response[2]<<8)|response[3];
        ok=ok && size==payload && (!payload || !memcmp(output,response+4,payload));
        ok=ok && !memcmp(output+payload,untouched+payload,sizeof output-payload);
    } else ok=ok && size==0xcafe && !memcmp(output,untouched,sizeof output);
    if(expected==FRAME_OK)ok=ok && request_size==2 && request_seen[0]==0xa5 && request_seen[1]==19;
    CHECK(name,ok);
}
int main(void) {
    reset(7);exercise("binary-reply",7,FRAME_OK,2000,0);
    reset(256);chunk=7;exercise("maximum-payload",256,FRAME_OK,2000,0);
    reset(0);exercise("empty-null-output",0,FRAME_OK,2000,1);
    reset(7);chunk=1;write_retries=2;read_retries=3;exercise("partial-io-with-retries",7,FRAME_OK,2000,0);
    reset(7);response[0]^=1;exercise("bad-magic",7,FRAME_PROTOCOL,2000,0);
    reset(7);response[1]++;exercise("wrong-request-id",7,FRAME_PROTOCOL,2000,0);
    reset(7);response[11]^=1;exercise("checksum-output-atomicity",7,FRAME_PROTOCOL,2000,0);
    reset(257);exercise("oversized-wire-length",300,FRAME_PROTOCOL,2000,0);
    reset(7);exercise("insufficient-capacity",6,FRAME_CAPACITY,2000,0);
    reset(7);response_size=3;exercise("header-disconnection",7,FRAME_IO,2000,0);
    reset(7);response_size=6;exercise("payload-disconnection",7,FRAME_IO,2000,0);
    reset(7);fatal_read=1;exercise("fatal-read-cleanup",7,FRAME_IO,2000,0);
    reset(7);open_failure=1;exercise("open-failure",7,FRAME_CONNECT,2000,0);
    reset(7);exercise("zero-budget-cleanup",7,FRAME_TIMEOUT,0,0);
    reset(7);blocked_read=1;exercise("retry-deadline-cleanup",7,FRAME_TIMEOUT,12,0);
    reset(7);chunk=1;tick=2;exercise("total-exchange-deadline",7,FRAME_TIMEOUT,12,0);
    reset(7);size_t size=99;unsigned char byte=0;
    CHECK("invalid-arguments",frame_fetch(NULL,19,&byte,1,&size,10)==FRAME_ARGUMENT && size==99 && !connection.alive);
    completed();return 0;
}
