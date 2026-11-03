#ifndef EVALUATION_REDIS_CLIENT_H
#define EVALUATION_REDIS_CLIENT_H
#include "check.h"
#include <errno.h>
#include <signal.h>
#include <stdarg.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/time.h>
#include <unistd.h>
typedef struct { char type; long long number; size_t size; unsigned char bytes[16384]; } response;
static void infrastructure(const char *message) { perror(message);exit(80); }
static int connect_server(void) {
    int fd=socket(AF_UNIX,SOCK_STREAM,0);if(fd<0)infrastructure("socket");
    struct sockaddr_un address={.sun_family=AF_UNIX};strcpy(address.sun_path,"build/verification/server.sock");
    if(connect(fd,(struct sockaddr*)&address,sizeof address))infrastructure("connect Redis");
    struct timeval timeout={.tv_sec=4};setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof timeout);
    setsockopt(fd,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof timeout);return fd;
}
static void send_bytes(int fd,const void *data,size_t length) {
    const unsigned char *p=data;
    while(length){ssize_t n=send(fd,p,length,MSG_NOSIGNAL);if(n<0 && errno==EINTR)continue;if(n<=0)infrastructure("send");p+=n;length-=(size_t)n;}
}
static int exact(int fd,void *data,size_t length) {
    unsigned char *p=data;
    while(length){ssize_t n=recv(fd,p,length,0);if(n<0 && errno==EINTR)continue;if(n<0)infrastructure("recv");if(!n)return 0;p+=n;length-=(size_t)n;}return 1;
}
static response reply(int fd) {
    response r={0};char line[1024];size_t n=0;
    if(!exact(fd,&r.type,1))return r;
    do {if(n>=sizeof line-1)infrastructure("RESP line too long");if(!exact(fd,line+n,1))infrastructure("truncated RESP");n++;}while(n<2 || line[n-2]!='\r' || line[n-1]!='\n');
    line[n-2]=0;
    if(r.type=='$'){
        r.number=strtoll(line,NULL,10);if(r.number<0)return r;
        if(r.number>(long long)sizeof r.bytes-1)infrastructure("RESP payload too long");
        r.size=(size_t)r.number;if(!exact(fd,r.bytes,r.size))infrastructure("truncated bulk");
        char crlf[2];if(!exact(fd,crlf,2)||memcmp(crlf,"\r\n",2))infrastructure("bad bulk terminator");
    }else if(r.type==':')r.number=strtoll(line,NULL,10);
    else {r.size=n-2;memcpy(r.bytes,line,r.size);}
    return r;
}
static void request(int fd,int count,...) {
    char header[64];int n=snprintf(header,sizeof header,"*%d\r\n",count);send_bytes(fd,header,(size_t)n);
    va_list args;va_start(args,count);
    for(int i=0;i<count;i++){const char *s=va_arg(args,const char*);size_t size=strlen(s);n=snprintf(header,sizeof header,"$%zu\r\n",size);send_bytes(fd,header,(size_t)n);send_bytes(fd,s,size);send_bytes(fd,"\r\n",2);}
    va_end(args);
}
static int text(response r,const char *s){return (r.type=='+' || r.type=='$') && r.size==strlen(s) && !memcmp(r.bytes,s,r.size);}
static int error_response(response r,const char *prefix){return r.type=='-' && r.size>=strlen(prefix) && !memcmp(r.bytes,prefix,strlen(prefix));}
static response command(int fd,int count,...) {
    const char *args[12];if(count>12)infrastructure("too many test arguments");va_list a;va_start(a,count);for(int i=0;i<count;i++)args[i]=va_arg(a,const char*);va_end(a);
    char header[64];int n=snprintf(header,sizeof header,"*%d\r\n",count);send_bytes(fd,header,(size_t)n);
    for(int i=0;i<count;i++){n=snprintf(header,sizeof header,"$%zu\r\n",strlen(args[i]));send_bytes(fd,header,(size_t)n);send_bytes(fd,args[i],strlen(args[i]));send_bytes(fd,"\r\n",2);}return reply(fd);
}
#endif
