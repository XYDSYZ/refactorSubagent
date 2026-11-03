#include "sds.h"
#include "zmalloc.h"
#include "check.h"
struct vector { const char *input; int argc; const char *words[4]; size_t sizes[4]; };
int main(void) {
    const struct vector cases[] = {
        {"",0,{0},{0}}, {" \t\r\n",0,{0},{0}},
        {"a b",2,{"a","b"},{1,1}}, {"'' \"\"",2,{"",""},{0,0}},
        {"'a b' \"c d\"",2,{"a b","c d"},{3,3}},
        {"\"a\\x00b\\xFF\"",1,{"a\0b\xff"},{4}},
        {"\"\\n\\r\\t\\b\\a\\\\\"",1,{"\n\r\t\b\a\\"},{6}},
        {"'it\\'s'",1,{"it's"},{4}}, {"abc\"de\"",1,{"abcde"},{5}},
        {"'a\\nb'",1,{"a\\nb"},{4}}
    };
    for (size_t i=0; i<sizeof cases/sizeof cases[0]; i++) {
        int argc=-1, ok=1;
        sds *args=sdssplitargs(cases[i].input,&argc);
        if (!args || argc!=cases[i].argc) ok=0;
        if (ok) for(int j=0;j<argc;j++)
            if(sdslen(args[j])!=cases[i].sizes[j] || memcmp(args[j],cases[i].words[j],cases[i].sizes[j])) ok=0;
        char name[32]; snprintf(name,sizeof name,"split-%zu",i);
        CHECK(name,ok);
        if(args) { for(int j=0;j<argc;j++) sdsfree(args[j]); zfree(args); }
    }
    const char *invalid[]={"\"open","'open","\"a\"b","'a'b","a \"unterminated"};
    for(size_t i=0;i<sizeof invalid/sizeof invalid[0];i++) {
        int argc=17; sds *args=sdssplitargs(invalid[i],&argc);
        char name[32]; snprintf(name,sizeof name,"invalid-%zu",i);
        CHECK(name,args==NULL && argc==0);
        if(args) { for(int j=0;j<argc;j++) sdsfree(args[j]); zfree(args); }
    }
    completed(); return 0;
}
