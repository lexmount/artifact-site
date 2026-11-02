/* SPDX-License-Identifier: MIT
 * Decode untrusted archives in a resource-limited subprocess. Never create files:
 * emit framed entries to the parent, which validates paths before writing storage.
 */
#include <archive.h>
#include <archive_entry.h>
#include <sys/resource.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <locale.h>

static void fail(const char *message) { fprintf(stderr, "%s\n", message); exit(1); }
static void number(uint64_t n, int bytes) {
  unsigned char b[8]; for (int i=bytes-1;i>=0;i--) { b[i]=n&255; n>>=8; }
  if (fwrite(b,1,bytes,stdout)!=(size_t)bytes) exit(1);
}
static void check_format(struct archive *a, const char *expected) {
  int format=archive_format(a)&ARCHIVE_FORMAT_BASE_MASK;
  int gzip=strcmp(expected,"tar.gz")==0;
  int valid=strcmp(expected,"zip")==0 ? format==ARCHIVE_FORMAT_ZIP :
    strcmp(expected,"rar")==0 ? (format==ARCHIVE_FORMAT_RAR || format==ARCHIVE_FORMAT_RAR_V5) :
    strcmp(expected,"7z")==0 ? format==ARCHIVE_FORMAT_7ZIP : format==ARCHIVE_FORMAT_TAR;
  /* Only gzip-wrapped TAR is supported, never gzip-wrapped ZIP or nested filters. */
  if(!valid || archive_filter_count(a)!=(gzip?2:1) || archive_filter_code(a,0)!=(gzip?ARCHIVE_FILTER_GZIP:ARCHIVE_FILTER_NONE))
    fail("Archive contents do not match the filename format");
}
int main(int argc, char **argv) {
  setlocale(LC_ALL, "");
  if(argc!=6) fail("Expected archive path, extraction limits and format");
  struct rlimit cpu={90,90}; setrlimit(RLIMIT_CPU,&cpu);
#ifdef __linux__
  struct rlimit memory={768ULL*1024*1024,768ULL*1024*1024}; setrlimit(RLIMIT_AS,&memory);
#endif
  uint64_t maxFiles=strtoull(argv[2],NULL,10), maxFile=strtoull(argv[3],NULL,10), maxTotal=strtoull(argv[4],NULL,10), count=0,total=0;
  struct archive *a=archive_read_new();
  archive_read_support_format_tar(a); archive_read_support_filter_gzip(a);
  archive_read_support_format_zip(a); archive_read_support_format_rar(a);
  archive_read_support_format_rar5(a); archive_read_support_format_7zip(a);
  if(archive_read_open_filename(a,argv[1],65536)!=ARCHIVE_OK) fail("Cannot open archive (unsupported, encrypted or corrupt)");
  struct archive_entry *e; int result;
  while((result=archive_read_next_header(a,&e))==ARCHIVE_OK) {
    check_format(a,argv[5]);
    if(++count>maxFiles*2) fail("Too many archive entries");
    if(archive_entry_is_encrypted(e)>0 || archive_entry_symlink(e) || archive_entry_hardlink(e)) fail("Encrypted or linked archive entries are unsupported");
    int type=archive_entry_filetype(e);
    if(type!=AE_IFREG && type!=AE_IFDIR) fail("Special archive entries are unsupported");
    const char *name=archive_entry_pathname_utf8(e);
    if(!name) name=archive_entry_pathname(e);
    if(!name || !strlen(name) || strlen(name)>1024) fail("Invalid archive path");
    int64_t size=archive_entry_size(e);
    if(size<0 || (uint64_t)size>maxFile || (type==AE_IFREG && total+(uint64_t)size>maxTotal)) fail("Archive exceeds decompression limits");
    if(type==AE_IFDIR) size=0;
    fputc(type==AE_IFDIR?'D':'F',stdout); number(strlen(name),4); number(size,8);
    if(fwrite(name,1,strlen(name),stdout)!=strlen(name)) exit(1);
    char buf[65536]; int64_t written=0; la_ssize_t n;
    while((n=archive_read_data(a,buf,sizeof(buf)))>0) {
      written+=n; total+=n;
      if(written>size || total>maxTotal) fail("Archive exceeds actual output limits");
      if(fwrite(buf,1,n,stdout)!=(size_t)n) exit(1);
    }
    if(n<0 || written!=size) fail("Corrupt archive entry");
  }
  if(result!=ARCHIVE_EOF || archive_read_has_encrypted_entries(a)>0) fail("Corrupt, encrypted or incomplete archive");
  check_format(a,argv[5]);
  archive_read_free(a);
  return fflush(stdout)==0?0:1;
}
