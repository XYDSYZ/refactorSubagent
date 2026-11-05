#include "redis_client.h"
int main(void){
    signal(SIGPIPE,SIG_IGN);int fd=connect_server();response r;
    CHECK("ping",text(command(fd,1,"PING"),"PONG"));
    CHECK("nx-create",text(command(fd,4,"SET","key","old","NX"),"OK"));
    r=command(fd,4,"SET","key","bad","NX");CHECK("nx-refuse",r.type=='$' && r.number==-1);
    CHECK("nx-keeps-value",text(command(fd,2,"GET","key"),"old"));
    CHECK("xx-get-old-value",text(command(fd,5,"SET","key","new","XX","GET"),"old"));
    CHECK("xx-stores-new-value",text(command(fd,2,"GET","key"),"new"));
    r=command(fd,5,"SET","absent","bad","XX","GET");CHECK("xx-missing",r.type=='$' && r.number==-1 && command(fd,2,"EXISTS","absent").number==0);
    command(fd,5,"SET","ttl","old","PX","60000");long long expiry=command(fd,2,"PEXPIRETIME","ttl").number;
    command(fd,4,"SET","ttl","new","KEEPTTL");CHECK("keepttl",expiry>0 && command(fd,2,"PEXPIRETIME","ttl").number==expiry);
    r=command(fd,6,"SET","ttl","bad","NX","PX","1");
    CHECK("failed-nx-keeps-expiry",r.type=='$' && r.number==-1 && command(fd,2,"PEXPIRETIME","ttl").number==expiry && text(command(fd,2,"GET","ttl"),"new"));
    r=command(fd,5,"SET","ttl","bad","NX","XX");
    CHECK("invalid-options-atomic",error_response(r,"ERR") && text(command(fd,2,"GET","ttl"),"new") && command(fd,2,"PEXPIRETIME","ttl").number==expiry);
    command(fd,4,"HSET","hash","field","value");r=command(fd,4,"SET","hash","bad","GET");
    CHECK("wrong-type-atomic",error_response(r,"WRONGTYPE") && text(command(fd,3,"HGET","hash","field"),"value"));
    r=command(fd,5,"SET","key","last","GET","GET");CHECK("repeated-get",text(r,"new") && text(command(fd,2,"GET","key"),"last"));
    command(fd,3,"SET","ttl","cleared");CHECK("plain-set-removes-ttl",command(fd,2,"PTTL","ttl").number==-1);
    close(fd);completed();return 0;
}
