#include "redis_client.h"
int main(int argc,char **argv){
    if(argc!=2)return 80;signal(SIGPIPE,SIG_IGN);int fd=connect_server();
    if(!strcmp(argv[1],"write")){
        CHECK("aof-set",text(command(fd,3,"SET","persist:key","original"),"OK"));
        CHECK("aof-hash",command(fd,4,"HSET","persist:hash","field","value").number==1);
        CHECK("aof-binary-safe",text(command(fd,3,"SET","persist:empty",""),"OK"));
    }else if(!strcmp(argv[1],"read")){
        CHECK("aof-increment-order",text(command(fd,2,"GET","persist:key"),"latest"));
        CHECK("aof-hash-restored",text(command(fd,3,"HGET","persist:hash","field"),"value"));
        CHECK("aof-empty-restored",text(command(fd,2,"GET","persist:empty"),""));
    }else return 80;
    close(fd);completed();return 0;
}
