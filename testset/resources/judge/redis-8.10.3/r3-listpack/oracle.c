#include "listpack.h"
#include "check.h"
struct item { unsigned char *bytes; size_t size; };
static void inspect(const char *name,unsigned char *lp,struct item *items,size_t count) {
    int valid=lpValidateIntegrity(lp,lpBytes(lp),1,NULL,NULL) && lpLength(lp)==count;
    unsigned char *p=lpFirst(lp);
    for(size_t i=0;i<count;i++) {
        unsigned char buffer[LP_INTBUF_SIZE]; int64_t size=0;
        if(!p) {valid=0; break;}
        unsigned char *value=lpGet(p,&size,buffer);
        if(!value || size!=(int64_t)items[i].size || memcmp(value,items[i].bytes,items[i].size)) valid=0;
        p=lpNext(lp,p);
    }
    if(p) valid=0;
    p=lpLast(lp);
    for(size_t i=count;i>0;i--) {
        unsigned char buffer[LP_INTBUF_SIZE]; int64_t size=0;
        if(!p) {valid=0; break;}
        unsigned char *value=lpGet(p,&size,buffer);
        if(!value || size!=(int64_t)items[i-1].size || memcmp(value,items[i-1].bytes,items[i-1].size)) valid=0;
        p=lpPrev(lp,p);
    }
    CHECK(name,valid && !p);
}
int main(void) {
    size_t lengths[]={0,63,64,125,126,4095,4096};
    unsigned char buffers[7][4096]; struct item items[12];
    unsigned char *lp=lpNew(0);
    for(size_t i=0;i<7;i++) {
        memset(buffers[i],'A'+(int)i,lengths[i]);
        items[i]=(struct item){buffers[i],lengths[i]};
        lp=lpAppend(lp,buffers[i],(uint32_t)lengths[i]);
        char name[32]; snprintf(name,sizeof name,"append-%zu",lengths[i]); inspect(name,lp,items,i+1);
    }
    unsigned char binary[]={0,1,0xff,0};
    unsigned char *p=lpSeek(lp,1);
    lp=lpReplace(lp,&p,buffers[6],4096); items[1]=items[6]; inspect("replace-grow",lp,items,7);
    lp=lpReplace(lp,&p,binary,sizeof binary); items[1]=(struct item){binary,sizeof binary}; inspect("replace-shrink",lp,items,7);
    lp=lpDelete(lp,lpFirst(lp),NULL); memmove(items,items+1,6*sizeof *items); inspect("delete-first",lp,items,6);
    lp=lpDelete(lp,lpLast(lp),NULL); inspect("delete-last",lp,items,5);
    const char *numbers[]={"01","-0","9223372036854775807","-9223372036854775808","9223372036854775808"};
    for(size_t i=0;i<5;i++) {
        lp=lpAppend(lp,(unsigned char*)numbers[i],strlen(numbers[i]));
        items[5+i]=(struct item){(unsigned char*)numbers[i],strlen(numbers[i])};
    }
    inspect("integer-boundaries",lp,items,10);
    lp=lpDeleteRange(lp,0,10); inspect("delete-all",lp,items,0);
    lp=lpAppend(lp,binary,sizeof binary); items[0]=(struct item){binary,sizeof binary}; inspect("append-after-empty",lp,items,1);
    lpFree(lp); completed(); return 0;
}
