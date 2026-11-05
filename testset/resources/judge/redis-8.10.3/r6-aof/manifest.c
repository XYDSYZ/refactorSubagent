#include "server.h"
#include "check.h"
/* Keep the real formatting implementation; no copied serializer. */
extern sds aofInfoFormat(sds buf,aofInfo *ai);
int main(void){
    struct example {const char *name,*filename,*expected;long long start,end;} cases[]={
        {"manifest-plain","plain.aof","file plain.aof seq 7 type i\n",-1,-1},
        {"manifest-space","a b.aof","file \"a b.aof\" seq 7 type i\n",-1,-1},
        {"manifest-quote","a\"b.aof","file \"a\\\"b.aof\" seq 7 type i\n",-1,-1},
        {"manifest-start","plain.aof","file plain.aof seq 7 type i startoffset 0\n",0,-1},
        {"manifest-end","plain.aof","file plain.aof seq 7 type i startoffset 11 endoffset 42\n",11,42}
    };
    for(size_t i=0;i<sizeof cases/sizeof cases[0];i++){
        aofInfo ai={0};ai.file_name=sdsnew(cases[i].filename);ai.file_seq=7;ai.file_type='i';
        ai.start_offset=cases[i].start;ai.end_offset=cases[i].end;
        sds line=aofInfoFormat(sdsempty(),&ai);
        CHECK(cases[i].name,sdslen(line)==strlen(cases[i].expected) && !memcmp(line,cases[i].expected,sdslen(line)));
        sdsfree(line);sdsfree(ai.file_name);
    }
    completed();return 0;
}
