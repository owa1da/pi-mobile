/* Deterministic concurrent-reply regression against production packet.c.
 * No sockets or servers: only transport_read is replaced by queued packets. */
#include "libssh2_priv.h"
#include "packet.h"
#include <stdio.h>
#include <stdlib.h>

static int step;
static int zero_first;

static void require(int condition, const char *message)
{
    if(!condition) {
        fprintf(stderr, "%s\n", message);
        exit(1);
    }
}

static void queue_success(LIBSSH2_SESSION *session, uint32_t channel)
{
    LIBSSH2_PACKET *packet = LIBSSH2_ALLOC(session, sizeof(*packet));
    require(packet != NULL, "packet allocation failed");
    memset(packet, 0, sizeof(*packet));
    packet->data = LIBSSH2_ALLOC(session, 5);
    require(packet->data != NULL, "payload allocation failed");
    packet->data_len = 5;
    packet->data[0] = SSH_MSG_CHANNEL_SUCCESS;
    _libssh2_htonu32(packet->data + 1, channel);
    _libssh2_list_add(&session->packets, &packet->node);
}

int __wrap__libssh2_transport_read(LIBSSH2_SESSION *session)
{
    if(step++ == 0) {
        if(zero_first)
            return 0;
        queue_success(session, 1);
        return SSH_MSG_CHANNEL_SUCCESS;
    }
    if(step == 2) {
        queue_success(session, 2);
        return SSH_MSG_CHANNEL_SUCCESS;
    }
    return LIBSSH2_ERROR_EAGAIN;
}

static void test(int zero)
{
    LIBSSH2_SESSION *session = libssh2_session_init();
    static const unsigned char types[] = {SSH_MSG_CHANNEL_SUCCESS,
                                         SSH_MSG_CHANNEL_FAILURE, 0};
    packet_requirev_state_t state = {0};
    unsigned char match[4], *data = NULL;
    size_t length = 0;
    int rc;
    require(session != NULL, "session allocation failed");
    session->socket_state = LIBSSH2_SOCKET_CONNECTED;
    step = 0;
    zero_first = zero;
    _libssh2_htonu32(match, 2);
    rc = _libssh2_packet_requirev(session, types, &data, &length, 1, match, 4, &state);
    require(rc == 0 && data != NULL && length == 5 && _libssh2_ntohu32(data + 1) == 2,
            zero ? "zero read incorrectly failed the pending reply" :
                   "another channel's reply incorrectly failed the pending reply");
    LIBSSH2_FREE(session, data);
    if(!zero) {
        _libssh2_htonu32(match, 1);
        require(_libssh2_packet_askv(session, types, &data, &length, 1, match, 4) == 0,
                "the other channel's reply was lost");
        LIBSSH2_FREE(session, data);
    }
    libssh2_session_abort(session);
    printf("PASS packet wait: %s\n", zero ? "zero-read continuation" : "other-channel reply preserved");
}

int main(void)
{
    require(libssh2_init(0) == 0, "libssh2 initialization failed");
    test(1);
    test(0);
    libssh2_exit();
    return 0;
}
