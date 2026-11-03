#include "redis_client.h"
#include <time.h>
static int buffered(int control,long long id){
    char number[32];snprintf(number,sizeof number,"%lld",id);
    struct timespec start,now;clock_gettime(CLOCK_MONOTONIC,&start);
    do{
        response r=command(control,4,"CLIENT","LIST","ID",number);r.bytes[r.size]=0;
        char *p=strstr((char*)r.bytes,"qbuf=");if(p && strtoul(p+5,NULL,10)>0)return 1;
        usleep(1000);clock_gettime(CLOCK_MONOTONIC,&now);
    }while((now.tv_sec-start.tv_sec)*1000+(now.tv_nsec-start.tv_nsec)/1000000<3000);
    return 0;
}
static void invalid(const char *name,const char *wire,int control){
    int fd=connect_server();send_bytes(fd,wire,strlen(wire));response r=reply(fd);
    int ok=error_response(r,"ERR Protocol error");unsigned char byte;
    if(ok){ssize_t n=recv(fd,&byte,1,0);ok=ok && n==0;}close(fd);
    int fresh=connect_server();ok=ok && text(command(fresh,1,"PING"),"PONG") && text(command(control,1,"PING"),"PONG");close(fresh);CHECK(name,ok);
}
int main(void){
    signal(SIGPIPE,SIG_IGN);int control=connect_server(),fd=connect_server();
    long long id=command(fd,2,"CLIENT","ID").number;
    const char *prefix="*3\r\n$3\r\nSET\r\n$8\r\nfrag:key\r\n$4\r\na";
    send_bytes(fd,prefix,strlen(prefix));CHECK("fragment-seen-by-server",buffered(control,id));
    const unsigned char tail[]={'b',0,'c','\r','\n'};send_bytes(fd,tail,sizeof tail);
    CHECK("fragment-completes",text(reply(fd),"OK"));response r=command(control,2,"GET","frag:key");
    CHECK("binary-payload",r.type=='$' && r.size==4 && !memcmp(r.bytes,"ab\0c",4));
    send_bytes(fd,"*1\r",3);CHECK("split-header-seen",buffered(control,id));
    send_bytes(fd,"\n$4\r\nPING\r\n",11);CHECK("split-header-completes",text(reply(fd),"PONG"));
    const char *pipeline="*1\r\n$4\r\nPING\r\n*2\r\n$4\r\nECHO\r\n$0\r\n\r\n*2\r\n$4\r\nECHO\r\n$3\r\nend\r\n";
    send_bytes(fd,pipeline,strlen(pipeline));int ok=text(reply(fd),"PONG");ok=ok && text(reply(fd),"");ok=ok && text(reply(fd),"end");CHECK("pipeline-state-reset",ok);close(fd);
    invalid("negative-bulk-length","*1\r\n$-1\r\n",control);
    invalid("trailing-length-garbage","*1\r\n$3x\r\nabc\r\n",control);
    invalid("overflow-array-length","*9223372036854775808\r\n",control);
    close(control);completed();return 0;
}
